// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Plugin core « Liens » : les liens [[...]] entre les notes (rendu,
// autocompletion, index) et le panneau des retroliens, les notes qui pointent
// vers la note ouverte. Le panneau ne vient qu'avec l'option backlinks :
// les pages de partage n'en ont pas.
import type { VaultPlugin, PluginAPI, NoteBlock, TriggerItem } from '@savoire/plugin-api'
import { blockIdInsertion, linkTargetFor, noteName, PROSE_BLOCK_KINDS, resolveLinkPath, splitNoteBlocks } from '@savoire/plugin-api'
import { WikilinkIndexContributor } from './WikilinkIndexContributor'
import { HeadingIndexContributor } from './HeadingIndexContributor'
import { allFilePaths } from './vaultFiles'
import { BacklinksWidget } from './BacklinksWidget'
import { BacklinksIndexContributor } from './BacklinksIndexContributor'

// [[Page]], [[Page#Heading]], [[Page|Alias]], [[Page#Heading|Alias]]
// Negative lookbehind for "!" so ![[...]] embeds are not touched.
const WIKILINK_RE = /(?<!!)(\[\[([^\]#|]+?)(?:#([^\]|]+?))?(?:\|([^\]]+))?\]\])/g

// Adresse d'un lien rendu : `#Page`, ou `#Page#Titre`, `#Page#^bloc` (la cible
// telle qu'ecrite). Le clic ouvre la note ; le survol en montre l'apercu
// (plugin-note-embed), titre ou bloc compris.
function toMarkdownLink(page: string, heading: string | undefined, alias: string | undefined): string {
  const label = alias ?? (heading ? `${page} > ${heading}` : page)
  const href = heading ? `#${page}#${heading}` : `#${page}`
  // Une adresse avec des espaces (« Genese 8 ») n'est un lien Markdown
  // qu'entre chevrons ; sans eux, le lien s'affichait en texte brut.
  const dest = /[\s()<>]/.test(href) ? `<${href.replace(/[<>]/g, '')}>` : href
  return `[${label}](${dest})`
}

/**
 * Chemin libre d'une sous-page de `notePath` : `A/Note.md` ->
 * `A/Note/Nouvelle page.md`, puis `Nouvelle page 2.md`... null sans extension.
 * `extension` : un autre type de document range sous la note (« excalidraw »...).
 */
export function newPagePath(notePath: string, existing: readonly string[], title = 'Nouvelle page', extension = 'md'): string | null {
  const slash = notePath.lastIndexOf('/')
  const name = notePath.slice(slash + 1)
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return null
  const folder = `${notePath.slice(0, slash + 1)}${name.slice(0, dot)}/`
  const taken = new Set(existing.map(p => p.toLowerCase()))
  let candidate = `${folder}${title}.${extension}`
  for (let n = 2; taken.has(candidate.toLowerCase()); n++) candidate = `${folder}${title} ${n}.${extension}`
  return candidate
}

/**
 * Chemin de la note a creer pour un lien `[[page]]` sans cible : sous la
 * note courante (newPagePath), ou au chemin ecrit s'il contient un dossier.
 * null : nom vide, ou pas de note courante.
 */
export function pagePathFor(page: string, notePath: string | null, existing: readonly string[]): string | null {
  const clean = page.replace(/[\\:*?"<>|]/g, '').replace(/\.md$/i, '').trim()
  if (!clean || clean.split('/').some(part => !part.trim() || part === '.' || part === '..')) return null
  if (clean.includes('/')) return `${clean}.md`
  return notePath ? newPagePath(notePath, existing, clean) : `${clean}.md`
}

/**
 * Le lien [[...]] ecrit en texte brut sous ce point de l'ecran (une ligne en
 * cours d'edition), ou null.
 */
export function rawLinkAt(x: number, y: number): string | null {
  const doc = document as Document & { caretPositionFromPoint?(x: number, y: number): { offsetNode: Node; offset: number } | null }
  let node: Node | null = null
  let offset = 0
  if (typeof doc.caretPositionFromPoint === 'function') {
    const pos = doc.caretPositionFromPoint(x, y)
    if (pos) { node = pos.offsetNode; offset = pos.offset }
  } else if (typeof document.caretRangeFromPoint === 'function') {
    const range = document.caretRangeFromPoint(x, y)
    if (range) { node = range.startContainer; offset = range.startOffset }
  }
  const line = (node instanceof Element ? node : node?.parentElement)?.closest('.cm-line')
  if (!node || !line) return null
  const before = document.createRange()
  before.setStart(line, 0)
  before.setEnd(node, offset)
  return wikilinkAtOffset(line.textContent ?? '', before.toString().length)
}

/** La page du lien [[...]] qui couvre cette position du texte, ou null. */
export function wikilinkAtOffset(text: string, at: number): string | null {
  for (const m of text.matchAll(/(?<!!)\[\[([^\]#|]*?)(?:#[^\]|]*?)?(?:\|[^\]]*)?\]\]/g)) {
    const start = m.index ?? 0
    if (at >= start && at <= start + m[0].length) return m[1].trim() || null
  }
  return null
}

/** La note et le morceau vises par un lien rendu (`#Page`, `#Page#Titre`, `#Page#^bloc`). */
export function linkTargetOf(href: string): { page: string; subpath: string } {
  let raw = href.replace(/^#/, '')
  try { raw = decodeURIComponent(raw) } catch { /* garde tel quel */ }
  const at = raw.indexOf('#')
  return at < 0 ? { page: raw.trim(), subpath: '' } : { page: raw.slice(0, at).trim(), subpath: raw.slice(at + 1) }
}

/** La note visee par un lien rendu. */
export function linkPageOf(href: string): string {
  return linkTargetOf(href).page
}

/** `Page#morceau` tape apres « [[ » : la page (vide : la note courante) et le morceau. */
export function splitSubpathQuery(query: string): { page: string; fragment: string } | null {
  const m = /^([^#|\]]*)#([^|\]]*)$/.exec(query)
  return m ? { page: m[1].trim(), fragment: m[2] } : null
}

/**
 * Identifiant propose pour un bloc qui n'en a pas : tire de son empreinte
 * (le meme a chaque frappe), allonge s'il est deja pris dans la note.
 */
export function proposedBlockId(block: NoteBlock, taken: ReadonlySet<string>): string {
  for (let n = 6; n <= 16; n++) {
    const id = block.hash.slice(0, n)
    if (!taken.has(id)) return id
  }
  return `${block.hash}-${block.index}`
}

/**
 * Propositions pour `[[Page#...` : les titres de la note, ou ses blocs apres
 * « ^ ». Un bloc sans identifiant en recoit un (ecrit dans la note visee au
 * choix, voir afterCommit) ; `canWrite` faux : seulement les blocs qui en ont un.
 */
export function subpathItems(target: string, blocks: readonly NoteBlock[], fragment: string, canWrite: boolean): TriggerItem[] {
  const clip = (t: string, n: number) => { const f = t.replace(/\s+/g, ' ').trim(); return f.length > n ? `${f.slice(0, n - 1)}…` : f }
  if (!fragment.startsWith('^')) {
    const q = fragment.trim().toLowerCase()
    return blocks
      .filter(b => b.kind === 'heading')
      .map(b => b.text.replace(/^\s*#+\s*/, '').replace(/\s+\^[A-Za-z0-9-]+\s*$/, '').trim())
      .filter(h => h && (!q || h.toLowerCase().includes(q)))
      .slice(0, 20)
      .map(h => ({ id: `wikiheading:${h}`, label: h, description: 'Titre', icon: 'heading', category: 'Titres', insert: `[[${target}#${h}]]` }))
  }
  const q = fragment.slice(1).trim().toLowerCase()
  const taken = new Set(blocks.flatMap(b => (b.blockId ? [b.blockId] : [])))
  const items: TriggerItem[] = []
  for (const b of blocks) {
    if (b.kind === 'heading' || (!PROSE_BLOCK_KINDS.has(b.kind) && b.kind !== 'code' && b.kind !== 'math')) continue
    if (!b.blockId && !canWrite) continue
    if (q && !b.text.toLowerCase().includes(q) && !(b.blockId ?? '').toLowerCase().startsWith(q)) continue
    const id = b.blockId ?? proposedBlockId(b, taken)
    items.push({
      id: b.blockId ? `wikiblock:${id}` : `wikiblock:new:${b.hash}:${id}`,
      label: clip(b.text, 70),
      description: b.blockId ? `^${b.blockId}` : (b.section ? `${b.section} · nouvel identifiant` : 'nouvel identifiant'),
      icon: 'pilcrow',
      category: 'Blocs',
      insert: `[[${target}#^${id}]]`,
    })
    if (items.length >= 30) break
  }
  return items
}

/** Ecrit « ^id » au bloc de cette empreinte, s'il est toujours la et sans identifiant. */
export function withBlockId(text: string, hash: string, id: string): string {
  const block = splitNoteBlocks(text).find(b => b.hash === hash)
  if (!block || block.blockId) return text
  const { at, insert } = blockIdInsertion(block, id)
  return text.slice(0, at) + insert + text.slice(at)
}

/** Ou placer le panneau des retroliens. */
export interface BacklinksPanelOptions {
  groupId?: string
  tabOf?: string
  belowOf?: string
  initialSize?: number
}

export function createWikilinksPlugin(options: { backlinks?: BacklinksPanelOptions } = {}): VaultPlugin {
  let removeListeners: (() => void) | null = null
  return {
    manifest: {
      id: 'plugin-wikilinks',
      scope: 'vault',
      name: 'Liens',
      version: '0.0.2',
      description: 'Les liens [[...]] entre les notes, et le panneau des notes qui pointent vers la note ouverte',
      permissions: ['ui:editor', 'vault:read'],
      defaultActive: true,
    },

    async onload(api: PluginAPI) {
      // ── Retroliens : index partage et panneau ────────────────────────────
      // Le panneau lit l'index de tout le vault quand il existe (pair
      // indexeur, index local du bureau), sinon cet index des notes deja vues.
      const panel = options.backlinks
      if (panel) {
        const links = new BacklinksIndexContributor()
        api.index?.registerFactory(() => links)
        api.views.register({
          id: 'backlinks',
          title: 'Backlinks',
          icon: 'link',
          groupId: panel.groupId,
          container: 'right',
          tabOf: panel.tabOf,
          belowOf: panel.belowOf,
          initialSize: panel.initialSize ?? 280,
          closable: true,
          createView(ctx) {
            return new BacklinksWidget(ctx, links, api.indexer)
          },
        })
      }

      // ── Autocompletion des references [[...]] ────────────────────────────
      //
      // Le trigger etait declare sans handler : il reservait la sequence « [[ »
      // sans jamais rien proposer. getItems() est SYNCHRONE, alors que
      // vault.list() est asynchrone — d'ou ce cache, rafraichi au chargement
      // puis a chaque changement du vault (creation, renommage, suppression).
      // Tous les hotes ne fournissent pas la surface complete : la page de
      // partage, par exemple, monte un editeur avec un vault reduit. Sans
      // liste, l'autocompletion se tait au lieu de casser le chargement.
      let notePaths: string[] = []
      const refreshNotes = async (): Promise<void> => {
        try {
          notePaths = typeof api.vault?.list === 'function' ? await allFilePaths(api.vault) : []
        } catch (err) {
          console.warn('[wikilinks] liste du vault indisponible', err)
          notePaths = []
        }
      }
      void refreshNotes()
      api.workspace?.subscribeVaultChange?.(() => { blockCache.clear(); void refreshNotes() })

      // Blocs des notes visees par [[Page#... : lus a la demande, gardes un moment.
      const blockCache = new Map<string, { at: number; docId: string; blocks: NoteBlock[] }>()
      const loading = new Set<string>()
      const loadBlocks = async (path: string): Promise<void> => {
        if (loading.has(path)) return
        const docId = api.vault?.resolveDocumentId?.(path)
        if (!docId || typeof api.vault?.read !== 'function') return
        loading.add(path)
        try {
          blockCache.set(path, { at: Date.now(), docId, blocks: splitNoteBlocks(await api.vault.read(docId)) })
        } catch { /* note illisible : pas de propositions */ } finally { loading.delete(path) }
      }
      const blocksOf = (path: string): { docId: string; blocks: NoteBlock[] } | null => {
        const hit = blockCache.get(path)
        if (!hit || Date.now() - hit.at > 30_000) void loadBlocks(path)
        return hit ?? null
      }

      const stemOf = noteName

      api.triggers.register({
        id: 'wikilinks',
        character: '[[',
        description: 'Lien wiki [[Page]]',
        handler: {
          getItems(query: string) {
            // [[Page#Titre, [[Page#^bloc : les morceaux de la note visee (vide : la note courante).
            const sub = splitSubpathQuery(query)
            if (sub) {
              const path = sub.page ? resolveLinkPath(sub.page, notePaths) : api.workspace?.getActiveDocument?.()?.path ?? null
              if (path) {
                // Premiere demande : les blocs arrivent a la frappe suivante.
                const found = blocksOf(path)
                const target = sub.page ? linkTargetFor(path, notePaths) : ''
                return found ? subpathItems(target, found.blocks, sub.fragment, typeof api.vault?.editText === 'function') : []
              }
            }
            const q = query.trim().toLowerCase()
            const scored = notePaths
              .map(path => ({ path, stem: stemOf(path) }))
              .filter(({ path, stem }) =>
                !q || stem.toLowerCase().includes(q) || path.toLowerCase().includes(q))
              .sort((a, b) => {
                // Une correspondance en debut de nom passe avant une au milieu.
                const ap = a.stem.toLowerCase().startsWith(q) ? 0 : 1
                const bp = b.stem.toLowerCase().startsWith(q) ? 0 : 1
                return ap - bp || a.stem.localeCompare(b.stem)
              })
              .slice(0, 20)

            const items = scored.map(({ path, stem }) => ({
              id: `wikilink:${path}`,
              label: stem,
              description: path,
              icon: 'link-2',
              category: 'Notes',
              // commitTriggerInsert() remplace « [[ » ET la requete saisie :
              // l'insertion doit donc porter le lien complet. Le nom seul
              // s'il est unique, sinon le chemin (comme Obsidian).
              insert: `[[${linkTargetFor(path, notePaths)}]]`,
            }))

            // Rien ne correspond mais l'utilisateur a tape quelque chose :
            // lui proposer de creer le lien tel quel plutot que de bloquer.
            if (items.length === 0 && q) {
              const raw = query.trim()
              items.push({
                id: `wikilink:new:${raw}`,
                label: raw,
                description: 'Nouvelle note (le lien pointera vers une note a creer)',
                icon: 'link-2',
                category: 'Nouveau',
                insert: `[[${raw}]]`,
              })
            }
            return items
          },
          // Un bloc choisi sans identifiant : « ^id » est ecrit dans la note visee.
          afterCommit(_activation, item) {
            const m = /^wikiblock:new:([0-9a-f]{16}):(.+)$/.exec(item.id)
            if (!m) return
            const insert = typeof item.insert === 'string' ? item.insert : ''
            const page = /^\[\[([^#\]]*)#/.exec(insert)?.[1] ?? ''
            const path = page ? resolveLinkPath(page, notePaths) : api.workspace?.getActiveDocument?.()?.path ?? null
            const docId = path ? blockCache.get(path)?.docId ?? api.vault?.resolveDocumentId?.(path) : undefined
            if (!docId || !path) return
            void api.vault.editText?.(docId, text => withBlockId(text, m[1], m[2])).then(() => { blockCache.delete(path) }, err => console.warn('[wikilinks] identifiant de bloc non ecrit', err))
          },
        },
      })

      // Ouvrir la note visee par un lien, ou la creer si elle n'existe pas
      // encore (comme Obsidian) : rangee sous la note courante, dans son
      // dossier (`A/Note.md` -> `A/Note/Nom.md`), comme ses images.
      const openOrCreate = async (page: string, subpath = ''): Promise<void> => {
        const found = resolveLinkPath(page, notePaths)
        // La suite du lien (« page=3 », « ^ancre ») : la vue du fichier y va, si elle sait.
        if (found) { await (subpath ? api.workspace?.openFile(found, { subpath }) : api.workspace?.openFile(found)); return }
        const path = pagePathFor(page, api.workspace?.getActiveDocument?.()?.path ?? null, notePaths)
        if (!path || typeof api.vault?.createFile !== 'function') return
        try {
          await api.vault.createFile(path)
        } catch (err) {
          console.warn('[wikilinks] page non creee', err)
          return
        }
        notePaths = [...notePaths, path]
        api.workspace?.notifyVaultChange?.()
        await api.workspace?.openFile(path)
      }

      // Clic sur un lien rendu dans une note : ouvrir la note visee (comme
      // Obsidian) ; Ctrl+clic sur un lien sans note la cree. Ctrl+clic (Cmd sur Mac) sur un lien en cours
      // d'ecriture ([[Nom]] en texte brut) fait de meme. Avant l'editeur, qui
      // passerait la ligne en edition.
      if (typeof document !== 'undefined') {
        const linkAt = (e: MouseEvent): { page: string; subpath: string } | null => {
          if (e.button !== 0) return null
          const target = e.target as Element | null
          const a = target?.closest?.('a[href^="#"]')
          if (a && (a.closest('.cm-editor') || a.closest('.link-preview'))) {
            const { page, subpath } = linkTargetOf(a.getAttribute('href') ?? '')
            // Une note absente ne se cree qu'au Ctrl+clic : pas par megarde.
            if (!page || (!resolveLinkPath(page, notePaths) && !(e.ctrlKey || e.metaKey))) return null
            return { page, subpath }
          }
          if (!(e.ctrlKey || e.metaKey) || !target?.closest?.('.cm-editor')) return null
          const page = rawLinkAt(e.clientX, e.clientY)
          return page ? { page, subpath: '' } : null
        }
        const onDown = (e: MouseEvent) => {
          const link = linkAt(e)
          if (!link) return
          e.preventDefault()
          e.stopPropagation()
          void openOrCreate(link.page, link.subpath)
        }
        const onClick = (e: MouseEvent) => { if (linkAt(e)) e.preventDefault() }
        document.addEventListener('mousedown', onDown, true)
        document.addEventListener('click', onClick, true)
        removeListeners = () => {
          document.removeEventListener('mousedown', onDown, true)
          document.removeEventListener('click', onClick, true)
        }
      }

      // « /page » : des crochets [[ ]] ou taper le nom de la page ; Ctrl+clic
      // sur le lien la cree, rangee sous la note courante.
      api.slash?.register({
        id: 'wikilinks:new-page',
        label: 'Page',
        description: 'Lien vers une nouvelle note : tapez son nom, Ctrl+clic la crée',
        icon: 'file',
        category: 'Insérer',
        insert: '[[]]',
        cursor: 2,
        keepOpen: true,
      })

      // Les autres types de documents (dessin, page, base...) : « /dessin »
      // en cree un sous la note courante et y pose un lien. Lus a chaque
      // ouverture du menu : un plugin active ou coupe suit.
      const createSubDocument = async (path: string, extension: string): Promise<void> => {
        await api.vault.createFile!(path)
        // Un type 'crdt' commence vide (sa vue pose la structure) ; les
        // autres recoivent leur contenu de depart, comme depuis l'explorateur.
        const spec = api.files?.resolve?.(extension)
        if (spec && spec.collaborationMode !== 'crdt') {
          const initial = await spec.create()
          const docId = api.vault.resolveDocumentId(path)
          if (initial && docId) await api.vault.write(docId, initial)
        }
        api.workspace?.notifyVaultChange?.()
      }
      api.slash?.register({
        id: 'wikilinks:new-document',
        label: 'Nouveau document',
        category: 'Nouveau document',
        insert: '',
        expand: () => {
          if (typeof api.vault?.createFile !== 'function') return []
          const specs = api.files?.getAll?.() ?? []
          return specs.filter(s => s.creatable !== false && s.extension !== 'md').map(spec => ({
            id: `wikilinks:new-document:${spec.extension}`,
            label: spec.label,
            description: `Nouveau document « ${spec.label} » sous cette note, avec un lien`,
            icon: spec.icon,
            category: 'Nouveau document',
            insert: () => {
              const note = api.workspace?.getActiveDocument?.()?.path ?? null
              const path = note ? newPagePath(note, notePaths, 'Sans titre', spec.extension) : null
              if (!path) return ''
              notePaths = [...notePaths, path]
              void createSubDocument(path, spec.extension).catch(err => console.warn('[wikilinks] document non cree', err))
              return `[[${path}]]`
            },
          }))
        },
      })

      api.hooks.beforeParse((source) => {
        return source.replace(
          WIKILINK_RE,
          (_m, _outer, page: string, heading: string | undefined, alias: string | undefined) =>
            toMarkdownLink(page, heading, alias)
        )
      })

      const wikilinkContributor = new WikilinkIndexContributor()
      api.index?.registerFactory(() => wikilinkContributor)
      api.index?.registerFactory(() => new HeadingIndexContributor())

    },

    async onunload() {
      removeListeners?.()
      removeListeners = null
    },
  }
}

export { WikilinkIndexContributor } from './WikilinkIndexContributor'
export { HeadingIndexContributor } from './HeadingIndexContributor'

export { BacklinksIndexContributor } from './BacklinksIndexContributor'
export { BacklinksWidget, type BacklinkSource } from './BacklinksWidget'
export type { BacklinkEntry } from './BacklinksIndexContributor'
