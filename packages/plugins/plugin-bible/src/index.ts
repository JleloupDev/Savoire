// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// plugin-bible (ancien « QuickRef ») : choisir et telecharger sa Bible, puis
// la citer dans une note, comme le plugin Obsidian QuickRefTS de l'auteur.
//  - panneau « Bible » : la Bible du dossier, le choix d'une Bible et son
//    telechargement (application bureau : voir bibles.ts et install.ts) ;
//  - « ! » puis un livre, un chapitre, un verset ou un mot : le menu propose,
//    Entree insere les integrations ![[Genese 1#^3]] ;
//  - Ctrl+Maj+B : la reference selectionnee (« Heb 12:3,7,8 ») -> ses versets
//    sous la ligne ;
//  - commande « tout le document » : les references entre parentheses.
// Les notes du dossier « Bible/ » sont lues au chargement du vault (tags
// Bible/Chapter et Bible/Book, alias, versets marques « ^numero »).
import type { PluginAPI, VaultPlugin } from '@savoire/plugin-api'
import { linkTargetFor } from '@savoire/plugin-api'
import { bibleAgentTools, type BibleToolState } from './agentTools'
import { addNote, emptyIndex, type ReferenceIndex } from './references'
import { ReferenceParser } from './parse'
import { DEFAULT_SETTINGS, suggest, type QuickRefSettings } from './suggest'
import { referenceBelowSelection, referencesInDocument } from './commands'
import { BIBLES, bibleById } from './bibles'
import { installBible, type InstallProgress } from './install'
import { indexPath, installedBibleId } from './notes'
import { BibleWidget, type BibleHost } from './BibleWidget'

export { ReferenceParser } from './parse'
export { bibleAgentTools, type BibleToolState } from './agentTools'
export { addNote, emptyIndex, extractVerses, normalize } from './references'
export { suggest, DEFAULT_SETTINGS } from './suggest'
export { referenceBelowSelection, referencesInDocument, embedsInLine } from './commands'
export type { QuickRefSettings } from './suggest'
export { BOOKS, CHAPTER_COUNT, type BibleBook } from './books'
export { BIBLES, bibleById, type BibleEdition } from './bibles'
export { parseWolChapter, pieceText, decodeEntities, wolChapterUrl, type ParsedVerse } from './wol'
export { chapterNote, bookNote, indexNote, chapterPath, bookPath, indexPath, installedBibleId } from './notes'
export { BibleWidget, type BibleHost } from './BibleWidget'
export { installBible, BibleInstallError, type InstallTarget, type InstallProgress, type InstallResult } from './install'

/** Lectures de notes en parallele au chargement. */
const READ_CONCURRENCY = 16
/** Attente apres un changement du vault avant de relire la liste. */
const RELOAD_DELAY_MS = 1000

/** Ce que les commandes utilisent de la vue CodeMirror de l'editeur. */
interface EditorViewLike {
  state: { doc: { toString(): string }; selection: { main: { from: number; to: number } } }
  dispatch(spec: { changes: { from: number; insert: string }[] }): void
}

// Ids d'avant le renommage : les raccourcis deja regles continuent de marcher.
const SELECTION_COMMAND = 'quickref:insert-from-selection'
const DOCUMENT_COMMAND = 'quickref:insert-in-document'
const CHOOSE_COMMAND = 'bible:choose'
const PANEL_ID = 'bible'

function asView(view: unknown): EditorViewLike | null {
  const v = view as Partial<EditorViewLike> | null | undefined
  return v && typeof v.dispatch === 'function' && v.state ? v as EditorViewLike : null
}

function escapeClass(ch: string): string {
  return ch.replace(/[\\\]^-]/g, '\\$&')
}

/**
 * « ! » en debut de ligne ou apres une espace, suivi d'au moins deux
 * caracteres (les espaces comptent : « !Gen 1:3 »). Pas « ![[ », l'integration.
 */
export function triggerPattern(trigger: string): RegExp {
  const t = escapeClass(trigger)
  const e = trigger.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(?:^|\\s)${e}([^\\s${t}\\[\\]][^${t}\\]\\n]+)$`)
}

async function allFilePaths(vault: PluginAPI['vault']): Promise<string[]> {
  const files: string[] = []
  const queue = ['']
  while (queue.length) {
    const dir = queue.shift()!
    for (const entry of await vault.list(dir || undefined)) {
      if (entry.endsWith('/')) { if (entry !== dir) queue.push(entry) }
      else files.push(entry)
    }
  }
  return files
}

async function eachLimited<T>(items: T[], limit: number, work: (item: T) => Promise<void>): Promise<void> {
  let next = 0
  const worker = async () => { while (next < items.length) await work(items[next++]) }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
}

export function createBiblePlugin(settings: QuickRefSettings = DEFAULT_SETTINGS): VaultPlugin {
  let index: ReferenceIndex = emptyIndex()
  let parser = new ReferenceParser(index, settings.separator)
  let allPaths: string[] = []
  /** Texte des notes du dossier, par chemin, dans l'ordre du dossier. */
  let contents = new Map<string, string>()
  /** Notes modifiees depuis leur lecture : a relire. */
  const stale = new Set<string>()
  let loading: Promise<void> | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  const targets = new Map<string, string>()
  const unsubscribers: (() => void)[] = []
  let host: PluginAPI | null = null

  /** Le nom seul s'il est unique dans le vault, sinon le chemin. */
  const linkTarget = (path: string): string => {
    let t = targets.get(path)
    if (t === undefined) { t = linkTargetFor(path, allPaths); targets.set(path, t) }
    return t
  }

  const isReference = (path: string) =>
    path.startsWith(settings.folder) && path.toLowerCase().endsWith('.md')

  /**
   * Relit la liste du vault, puis les notes du dossier nouvelles ou
   * modifiees ; les autres gardent le texte deja lu. L'index est refait
   * (dans l'ordre du dossier : la recherche rend les versets dans l'ordre
   * de la Bible).
   */
  async function load(api: PluginAPI): Promise<void> {
    if (typeof api.vault?.list !== 'function') return
    const paths = await allFilePaths(api.vault)
    const refs = paths.filter(isReference).sort((a, b) => a.localeCompare(b, 'fr', { numeric: true }))
    allPaths = paths
    targets.clear()
    const toRead = refs.filter(p => !contents.has(p) || stale.has(p))
    const unchanged = toRead.length === 0 && refs.length === contents.size
    if (unchanged) return
    for (const p of toRead) stale.delete(p)
    const read = new Map<string, string>()
    await eachLimited(toRead, READ_CONCURRENCY, async path => {
      try { read.set(path, await api.vault.readDocumentByPath(path)) }
      catch (err) { console.warn(`[bible] lecture impossible : ${path}`, err) }
    })
    const nextContents = new Map<string, string>()
    const next = emptyIndex()
    for (const path of refs) {
      const content = read.get(path) ?? contents.get(path)
      if (content === undefined) continue
      nextContents.set(path, content)
      addNote(next, path, content)
    }
    contents = nextContents
    index = next
    parser = new ReferenceParser(index, settings.separator)
  }

  function reload(api: PluginAPI): Promise<void> {
    loading = (loading ?? Promise.resolve()).then(() => load(api)).catch(err => {
      console.warn('[bible] chargement des references impossible', err)
    })
    return loading
  }

  function reloadSoon(api: PluginAPI): void {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => { timer = null; void reload(api) }, RELOAD_DELAY_MS)
  }

  /** Les references, chargees ; previent la personne si elles ne le sont pas. */
  async function ready(api: PluginAPI): Promise<boolean> {
    if (loading) await loading
    if (index.byName.size === 0) {
      api.workspace?.notify?.('warn', 'Aucune Bible', `Le dossier « ${settings.folder} » est vide : choisissez une Bible dans le panneau « Bible ».`)
      return false
    }
    return true
  }

  /** Ce dont le panneau a besoin : lire le dossier, telecharger, ecrire les notes. */
  function makeBibleHost(api: PluginAPI): BibleHost {
    const vault = api.vault
    const createNote = async (path: string, text: string) => {
      if (!vault.createFile) throw new Error('Ce vault ne permet pas de créer de note.')
      await vault.createFile(path)
      let id = vault.resolveDocumentId(path)
      for (let i = 0; !id && i < 100; i++) {
        await new Promise(r => setTimeout(r, 50))
        id = vault.resolveDocumentId(path)
      }
      if (!id) throw new Error(`Note introuvable après sa création : ${path}`)
      if (vault.editText) await vault.editText(id, () => text)
      else await vault.write(id, text)
    }
    return {
      folder: settings.folder,
      bibles: BIBLES,
      async installedId() {
        const path = indexPath(settings.folder)
        if (!vault.resolveDocumentId(path)) return null
        try { return installedBibleId(await vault.readDocumentByPath(path)) } catch { return null }
      },
      hasNotes: () => allPaths.some(isReference) || contents.size > 0,
      unavailable() {
        if (!api.network) {
          return 'Le téléchargement depuis wol.jw.org se fait dans l\'application bureau (un navigateur ne peut pas lire ce site). '
            + 'Sur le web, installez-la depuis le Savoire Store (Réglages, Store, sorte « Notes »).'
        }
        if (typeof vault.createFile !== 'function') return 'Ouvrez un vault pour y télécharger une Bible.'
        return null
      },
      async install(id: string, onProgress: (p: InstallProgress) => void, cancelled: () => boolean) {
        const bible = bibleById(id)
        if (!bible) throw new Error(`Bible inconnue : ${id}`)
        const network = api.network
        if (!network) throw new Error(this.unavailable() ?? 'Accès au réseau indisponible.')
        const result = await installBible({
          fetchText: url => network.fetchText(url),
          exists: path => !!vault.resolveDocumentId(path),
          createNote,
        }, bible, { root: settings.folder, onProgress, cancelled })
        void reload(api)
        if (!result.cancelled) api.workspace?.notify?.('success', 'Bible installée', `${bible.name} : ${result.written} note(s) écrite(s).`)
        return result
      },
    }
  }

  return {
    manifest: {
      id: 'plugin-bible',
      name: 'Bible',
      version: '0.1.0',
      description: 'Choisir et télécharger sa Bible, puis citer : « ! » et un livre, un chapitre ou un mot insère les versets',
      scope: 'vault',
      permissions: ['ui:editor', 'vault:read', 'vault:write', 'network:wol.jw.org', 'agents'],
      defaultActive: true,
      trust: 'verified',
    },

    async onload(api: PluginAPI) {
      host = api
      void reload(api)
      // Agents (ADR-033) : chercher et citer des versets, inserer une reference.
      const toolState: BibleToolState = {
        parser: async () => { if (loading) await loading; return index.byName.size ? parser : null },
        linkTarget,
      }
      for (const tool of bibleAgentTools(api, toolState)) api.agents?.registerTool(tool)
      // Fichiers crees, renommes, supprimes : la liste est relue.
      const unsubVault = api.workspace?.subscribeVaultChange?.(() => reloadSoon(api))
      if (unsubVault) unsubscribers.push(unsubVault)
      // Une note du dossier modifiee : elle seule est relue.
      const unsubDoc = api.workspace?.subscribeDocumentIndexed?.((_id, path) => {
        if (!isReference(path)) return
        stale.add(path)
        reloadSoon(api)
      })
      if (unsubDoc) unsubscribers.push(unsubDoc)

      // Un hote minimal (le test du catalogue du store) n'a pas de declencheurs.
      api.triggers?.register({
        id: 'quickref',
        character: settings.trigger,
        pattern: triggerPattern(settings.trigger),
        description: 'Référence biblique (!Gen 1:3)',
        handler: {
          getItems: (query: string) => index.byName.size ? suggest(parser, query, settings, linkTarget) : [],
        },
      })

      const fromSelection = (view: EditorViewLike | null) => {
        if (!view) return
        void ready(api).then(ok => {
          if (!ok) return
          const { from, to } = view.state.selection.main
          const r = referenceBelowSelection(view.state.doc.toString(), from, to, parser, linkTarget)
          if (r.ok) { view.dispatch({ changes: [{ from: r.insertion.at, insert: r.insertion.insert }] }); return }
          if (r.reason === 'empty') {
            api.workspace?.notify?.('info', 'Rien de sélectionné', 'Sélectionnez une référence, par exemple « Hébreux 12:3,7,8 ».')
          } else {
            api.workspace?.notify?.('warn', 'Référence non reconnue', `« ${r.text} »`)
          }
        })
      }
      const inDocument = (view: EditorViewLike | null) => {
        if (!view) return
        void ready(api).then(ok => {
          if (!ok) return
          const r = referencesInDocument(view.state.doc.toString(), parser, linkTarget)
          if (!r.verses) {
            api.workspace?.notify?.('info', 'Aucune référence', 'Aucune référence biblique nouvelle entre parenthèses.')
            return
          }
          view.dispatch({ changes: r.insertions.map(i => ({ from: i.at, insert: i.insert })) })
          api.workspace?.notify?.('success', `${r.verses} verset(s) ajouté(s)`, `pour ${r.lines} ligne(s)`)
        })
      }

      api.commands?.register({
        id: SELECTION_COMMAND,
        label: 'Bible : versets de la référence sélectionnée',
        hotkeys: [{ modifiers: ['Mod', 'Shift'], key: 'B' }],
        editor: true,
        run: (ctx) => fromSelection(asView(ctx.editorView)),
      })
      api.commands?.register({
        id: DOCUMENT_COMMAND,
        label: 'Bible : versets des références entre parenthèses (tout le document)',
        editor: true,
        run: (ctx) => inDocument(asView(ctx.editorView)),
      })
      // Panneau « Bible » : choisir et telecharger.
      const bibleHost = makeBibleHost(api)
      api.views?.register({
        id: PANEL_ID,
        title: 'Bible',
        icon: 'book-open',
        container: 'right',
        closable: true,
        initialSize: 300,
        createView: ctx => new BibleWidget(ctx, bibleHost),
      })
      api.commands?.register({
        id: CHOOSE_COMMAND,
        label: 'Bible : choisir et télécharger une Bible',
        run: () => api.workspace?.openPanel(PANEL_ID),
      })

      // Dans la barre de l'editeur : les deux commandes (l'appli n'a pas de
      // palette de commandes ; un raccourci se pose dans Reglages).
      api.toolbar?.register({
        id: 'quickref',
        label: 'Versets bibliques',
        icon: 'book-open',
        group: 'insert',
        run: (ctx) => fromSelection(asView(ctx.view)),
        items: [
          { id: 'quickref-selection', label: 'Versets de la sélection', icon: 'book-open', commandId: SELECTION_COMMAND, run: (ctx) => fromSelection(asView(ctx.view)) },
          { id: 'quickref-document', label: 'Versets de tout le document', icon: 'book-open', commandId: DOCUMENT_COMMAND, run: (ctx) => inDocument(asView(ctx.view)) },
          { id: 'bible-choose', label: 'Choisir et télécharger une Bible', icon: 'download', commandId: CHOOSE_COMMAND, run: () => api.workspace?.openPanel(PANEL_ID) },
        ],
      })
    },

    async onunload() {
      if (timer) clearTimeout(timer)
      for (const u of unsubscribers.splice(0)) u()
      host?.triggers?.unregister('quickref')
      host?.commands?.unregister(SELECTION_COMMAND)
      host?.commands?.unregister(DOCUMENT_COMMAND)
      host?.commands?.unregister(CHOOSE_COMMAND)
      host?.views?.unregister(PANEL_ID)
      host?.toolbar?.unregister('quickref')
      host = null
    },
  }
}

export default createBiblePlugin()
