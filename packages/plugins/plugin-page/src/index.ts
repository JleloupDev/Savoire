// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// plugin-page — des pages facon Notion, fichiers .page.
//
// Editeur de blocs Tiptap. Le contenu d'une page est son arbre de document
// (ProseMirror), stocke dans l'arbre partage du document (ctx.tree) : edition
// simultanee, sans verrou, avec ou sans serveur. Sans arbre, mode local :
// le meme arbre en JSON dans le fichier, via ctx.vault.
//
// Mise en forme : au clavier (commandes page:*), par le menu « / » et par la
// barre d'edition flottante a la selection (toolbar.ts).
//
// Yjs n'apparait nulle part dans l'API : il sert seulement de modele prive a
// l'editeur (y-prosemirror), recopie dans l'arbre par adapter/TreeMirror.
import type { FileContext, PluginAPI, VaultPlugin } from '@savoire/plugin-api'
import { createPageView } from './view'
import { pageCommands } from './commands'
import { pageFileToMarkdown } from './markdown'

export { createPageView, pageEditorOf } from './view'
export { pageCommands, focusedPageEditor, runPageCommand } from './commands'
export { Highlight, PAGE_COLORS } from './highlight'
export { pageExtensions, PageLink } from './schema'
export { filterBlocks, matchSlash, BLOCK_ITEMS } from './blocks'
export { pageToMarkdown, pageFileToMarkdown } from './markdown'
export { subPagePath, subPageFolder, linkTargetOf, resolveLinkTarget, cleanPageName } from './subpage'

let registeredCommands: string[] = []
let unregister: ((id: string) => void) | null = null

const plugin: VaultPlugin = {
  manifest: {
    id: 'plugin-page',
    name: 'Pages',
    version: '0.0.1',
    description: 'Des pages facon Notion : blocs, menu /, sous-pages (fichiers .page)',
    scope: 'vault',
    permissions: ['ui:editor'],
  },

  async onload(api: PluginAPI) {
    api.files.register({
      extension: 'page',
      label: 'Page',
      icon: '📄',
      // Le contenu est un arbre CRDT : edition simultanee, sans verrou.
      collaborationMode: 'crdt',
      creatable: true,
      // Page vide : pas de titre dans le contenu, c'est le nom du fichier.
      create: async () => '',
      open: (path: string, ctx: FileContext) => createPageView(path, ctx, { workspace: api.workspace, vault: api.vault, hotkeys: api.hotkeys }),
      contentExtractor: { toShadowDocument: pageFileToMarkdown },
    })
    const commands = pageCommands()
    // Un hote sans registre de commandes (catalogue du store) : le type suffit.
    for (const c of commands) api.commands?.register(c)
    registeredCommands = commands.map(c => c.id)
    unregister = id => api.commands?.unregister(id)
  },

  async onunload() {
    for (const id of registeredCommands) unregister?.(id)
    registeredCommands = []
    unregister = null
  },
}

export default plugin
