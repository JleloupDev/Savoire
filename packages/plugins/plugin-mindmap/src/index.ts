// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// plugin-mindmap — editeur de cartes mentales (mind-elixir) pour les fichiers .mm
//
// see ADR-023
//
// Edition a plusieurs : la carte est stockee dans l'arbre partage du
// document (ctx.tree), en modele plat (voir model.ts). Plusieurs membres
// l'editent en meme temps, sans verrou. Sans arbre partage (pas de session
// de vault), la vue est en lecture seule.
//
// Un ancien fichier .mm (instantane JSON, du temps du verrou) est affiche
// tel quel tant que l'arbre est vide, et recopie dans l'arbre a la premiere
// modification (voir view.ts).
import MindElixir from 'mind-elixir'
import type { VaultPlugin, PluginAPI, FileContext } from '@savoire/plugin-api'
import { MINDMAP_ACTIONS, mindmapCommands } from './commands'
import { createMindmapView } from './view'
import { emptyMap, parseLegacy } from './model'

export { MindmapEditor, createMindmapView, focusedMindmap } from './view'
export { MINDMAP_ACTIONS, mindmapCommands } from './commands'
export * from './model'
export { keyBetween, reorderKeys, compareSiblings } from './order'

// ── Embed en lecture seule ───────────────────────────────────────────────

async function renderMindmapEmbed(path: string, ctx: FileContext): Promise<HTMLElement> {
  const wrapper = document.createElement('div')
  wrapper.style.cssText = [
    'height:320px', 'width:100%',
    'border:1px solid var(--border,#313244)',
    'border-radius:6px', 'overflow:hidden',
  ].join(';')

  const el = document.createElement('div')
  el.style.cssText = 'height:100%;width:100%;'
  wrapper.appendChild(el)

  let raw = ''
  if (ctx.vault) {
    try { raw = await ctx.vault.readDocumentByPath(path) } catch { /* carte vide */ }
  }
  const data = parseLegacy(raw) ?? emptyMap(path.split('/').at(-1)?.replace(/\.mm$/, '') || 'Carte')

  const me = new MindElixir({
    el,
    direction: MindElixir.RIGHT,
    draggable: false,
    contextMenu: false,
    toolBar: false,
    keypress: false,
    editable: false,
  })
  me.init(data)

  return wrapper
}

// ── Plugin ───────────────────────────────────────────────────────────────

let pluginAPI: PluginAPI | null = null

const plugin: VaultPlugin = {
  manifest: {
    id: 'plugin-mindmap',
    scope: 'vault',
    name: 'Mind Map',
    version: '0.0.2',
    description: 'Éditeur de mind maps interactif pour les fichiers .mm',
    permissions: ['ui:editor', 'vault:read', 'vault:write'],
    defaultActive: false,
  },

  async onload(api: PluginAPI) {
    pluginAPI = api
    api.files.register({
      extension: 'mm',
      label: 'Mind Map',
      icon: '🧠',
      // L'arbre du document est un CRDT : edition simultanee, sans verrou.
      collaborationMode: 'crdt',

      // Un document 'crdt' neuf commence vide : la vue pose la racine a la
      // premiere modification. Ce contenu n'est pas ecrit.
      create: async () => '',

      open: (path: string, ctx: FileContext) => createMindmapView(path, ctx, pluginAPI),

      renderEmbed: (path: string, ctx: FileContext) => renderMindmapEmbed(path, ctx),
    })
    // Apres le type de fichier : un hote minimal peut ne fournir que `files`.
    for (const cmd of mindmapCommands()) api.commands?.register(cmd)
  },

  async onunload() {
    for (const a of MINDMAP_ACTIONS) pluginAPI?.commands?.unregister(a.id)
    pluginAPI?.files.unregister('mm')
    pluginAPI = null
  },
}

export default plugin
