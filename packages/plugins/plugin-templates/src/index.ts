// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Plugin core « Modeles », simple comme celui d'Obsidian : chaque note du
// dossier des modeles (`Modèles/`, ou `Templates/` d'un vault Obsidian)
// devient une commande « /Modèle : Nom » qui insere son texte au curseur,
// variables remplacees ({{title}}, {{date}}, {{time}}, formats : voir
// renderTemplate dans plugin-api).
//
// Le texte des modeles est lu a l'avance et tenu a jour : l'insertion du
// menu / est immediate.
//
// Comme dans Obsidian aussi : la commande « Insérer un modèle »
// (templates:insert-template) ouvre la liste des modeles ; les proprietes
// d'un modele rejoignent celles de la note (insert.ts) ; « Insérer la date »
// et « Insérer l'heure » ; le dossier des modeles se choisit (sinon
// `Modèles/` ou `Templates/`), pour ce vault sur ce poste.
import type { PluginAPI, VaultPlugin } from '@savoire/plugin-api'
import { formatDate, noteTitleOf, renderTemplate, templateFolderOf } from '@savoire/plugin-api'
import { templateAgentTools } from './agentTools'
import { insertTemplate, mergeTemplateProperties, splitTemplate } from './insert'
import { pick } from './picker'

export { insertTemplate, mergeTemplateProperties, splitTemplate } from './insert'

const FOLDER_KEY = 'savoire-templates-folder:'

/** Dossier des modeles choisi pour ce vault (sur ce poste), ou null. */
export function chosenTemplateFolder(vaultId: string | undefined): string | null {
  if (!vaultId || typeof localStorage === 'undefined') return null
  try { return localStorage.getItem(FOLDER_KEY + vaultId) } catch { return null }
}

function setChosenTemplateFolder(vaultId: string | undefined, folder: string | null): void {
  if (!vaultId || typeof localStorage === 'undefined') return
  try {
    if (folder) localStorage.setItem(FOLDER_KEY + vaultId, folder)
    else localStorage.removeItem(FOLDER_KEY + vaultId)
  } catch { /* navigation privee */ }
}

/** Une vue CodeMirror, vue de loin (le plugin ne depend pas de CodeMirror). */
interface TextView {
  state: { doc: { toString(): string; length: number }; selection: { main: { from: number; to: number; head: number } }; replaceSelection(text: string): unknown }
  dispatch(spec: unknown): void
  focus(): void
}

function textViewOf(v: unknown): TextView | null {
  const t = v as Partial<TextView> | null
  return t && typeof t.dispatch === 'function' && t.state ? t as TextView : null
}

async function allFiles(api: PluginAPI): Promise<string[]> {
  const files: string[] = []
  const queue = ['']
  while (queue.length) {
    const dir = queue.shift()!
    for (const entry of await api.vault.list(dir || undefined)) {
      if (entry.endsWith('/')) { if (entry !== dir) queue.push(entry) }
      else files.push(entry)
    }
  }
  return files
}

/** Les modeles d'un vault : notes Markdown de son dossier des modeles (`chosen` : celui choisi). */
export function templatePaths(files: readonly string[], chosen: string | null = null): string[] {
  const folder = chosen ? (chosen.endsWith('/') ? chosen : `${chosen}/`) : templateFolderOf(files)
  if (!folder) return []
  return files
    .filter(f => f.startsWith(folder) && f.toLowerCase().endsWith('.md'))
    .sort((a, b) => a.localeCompare(b))
}

const plugin: VaultPlugin = {
  manifest: {
    id: 'plugin-templates',
    name: 'Modèles',
    version: '0.0.1',
    description: 'Les notes du dossier « Modèles » s\'insèrent par le menu /, avec {{title}}, {{date}} et {{time}}',
    scope: 'vault',
    permissions: ['ui:editor', 'vault:read', 'vault:write', 'agents'],
    defaultActive: true,
    // Livre avec Savoire : ses outils d'agent tournent aussi sur le pair indexeur.
    official: true,
  },

  async onload(api: PluginAPI) {
    // Agents (ADR-033) : lister les modeles, creer une note depuis un modele.
    if (typeof api.vault?.list === 'function') {
      for (const tool of templateAgentTools(api, async () => templatePaths(await allFiles(api), chosenTemplateFolder(api.vault.getVaultId?.())))) api.agents?.registerTool(tool)
    }
    if (!api.slash || typeof api.vault?.list !== 'function') return
    const texts = new Map<string, string>()
    let generation = 0

    const refresh = async () => {
      const mine = ++generation
      let paths: string[]
      try { paths = templatePaths(await allFiles(api), chosenTemplateFolder(api.vault.getVaultId?.())) } catch { return }
      const read = await Promise.all(paths.map(async p => {
        try { return [p, await api.vault.readDocumentByPath(p)] as const } catch { return null }
      }))
      if (mine !== generation) return
      texts.clear()
      for (const r of read) if (r) texts.set(r[0], r[1])
    }

    // Un seul item enregistre au chargement (il suit l'activation du plugin),
    // qui donne un item par modele a l'ouverture du menu.
    api.slash.register({
      id: 'templates',
      label: 'Modèle',
      category: 'Modèles',
      insert: '',
      expand: () => {
        // Relu a chaque ouverture du menu : un modele modifie a l'instant suit.
        void refresh()
        return [...texts.keys()].map(path => ({
        id: `templates:${path}`,
        label: `Modèle : ${noteTitleOf(path)}`,
        description: path,
        icon: 'layout-template',
        category: 'Modèles',
        insert: () => {
          const current = api.workspace?.getActiveDocument?.()?.path
          const { properties, body } = splitTemplate(renderTemplate(texts.get(path) ?? '', { title: current ? noteTitleOf(current) : '' }))
          // Les proprietes du modele rejoignent celles de la note, une fois le corps insere.
          const docId = current ? api.vault.resolveDocumentId(current) : undefined
          if (properties.length && docId && api.vault.editText) {
            setTimeout(() => { void api.vault.editText!(docId, text => mergeTemplateProperties(text, properties)) }, 0)
          }
          return body
        },
        }))
      },
    })

    // ── Commandes (identifiants d'Obsidian) ──────────────────────────────
    const activeTitle = () => {
      const current = api.workspace?.getActiveDocument?.()?.path
      return current ? noteTitleOf(current) : ''
    }
    /** Insere au curseur de l'editeur, sinon a la fin de la note active. */
    const insertText = async (view: TextView | null, text: string, merge = true) => {
      if (view) {
        const note = view.state.doc.toString()
        const at = view.state.selection.main.head
        const next = merge ? insertTemplate(note, at, text) : { text: note.slice(0, at) + text + note.slice(at), cursor: at + text.length }
        view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: next.text }, selection: { anchor: next.cursor }, userEvent: 'input' })
        view.focus()
        return
      }
      const current = api.workspace?.getActiveDocument?.()?.path
      const docId = current ? api.vault.resolveDocumentId(current) : undefined
      if (!docId || !api.vault.editText) return
      await api.vault.editText(docId, note => (merge ? insertTemplate(note, note.length, text).text : note + text))
    }
    api.commands.register({
      id: 'templates:insert-template',
      label: 'Insérer un modèle',
      run: async (ctx) => {
        const view = textViewOf(ctx.editorView)
        await refresh()
        const items = [...texts.keys()].map(p => ({ value: p, label: noteTitleOf(p), detail: p }))
        if (!items.length) {
          api.workspace?.notify?.('info', 'Aucun modèle', 'Rangez des notes dans « Modèles/ » (ou choisissez le dossier des modèles).')
          return
        }
        const chosen = await pick(items, 'Choisir un modèle…')
        if (chosen) await insertText(view, renderTemplate(texts.get(chosen.value) ?? '', { title: activeTitle() }))
      },
    })
    api.commands.register({
      id: 'templates:insert-current-date',
      label: 'Insérer la date du jour',
      run: (ctx) => insertText(textViewOf(ctx.editorView), formatDate(new Date(), 'YYYY-MM-DD'), false),
    })
    api.commands.register({
      id: 'templates:insert-current-time',
      label: 'Insérer l\'heure',
      run: (ctx) => insertText(textViewOf(ctx.editorView), formatDate(new Date(), 'HH:mm'), false),
    })
    api.commands.register({
      id: 'templates:choose-folder',
      label: 'Modèles : choisir le dossier des modèles',
      run: async () => {
        const files = await allFiles(api).catch(() => [] as string[])
        const folders = [...new Set(files.filter(f => !f.startsWith('.')).map(f => f.slice(0, f.lastIndexOf('/') + 1)).filter(Boolean))].sort()
        const vaultId = api.vault.getVaultId?.()
        const items = [
          { value: '', label: 'Automatique', detail: '« Modèles/ » ou « Templates/ »' },
          ...folders.map(f => ({ value: f, label: f })),
        ]
        const chosen = await pick(items, 'Dossier des modèles…')
        if (!chosen) return
        setChosenTemplateFolder(vaultId, chosen.value || null)
        await refresh()
      },
    })

    void refresh()
    // Un modele ajoute, renomme ou modifie : la liste suit.
    api.workspace?.subscribeVaultChange?.(() => void refresh())
    api.workspace?.subscribeDocumentIndexed?.((_id: string, path: string) => {
      if (templatePaths([path], chosenTemplateFolder(api.vault.getVaultId?.())).length) void refresh()
    })
  },

  async onunload() {},
}

export default plugin
