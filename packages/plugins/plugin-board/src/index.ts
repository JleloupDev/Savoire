// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// plugin-board — « Boards » : des mini applis en HTML, CSS et JavaScript
// (fichiers .board), qui interrogent et modifient les bases du vault.
//
// Le code d'un board s'execute dans une iframe isolee (frame.ts) et ne parle
// a Savoire que par l'API de host.ts. Un board s'integre dans une note :
// ![[Tableau de bord.board]].
import type { FileContext, PluginAPI, VaultPlugin } from '@savoire/plugin-api'
import { parseBoardEmbed, renderBoardEmbed } from './embed'
import { createBoardView } from './view'

export { BoardHost, resetBoardGrants, MAX_WRITES_PER_MINUTE, MAX_WATCHES } from './host'
export type { BoardHostOptions } from './host'
export { buildSrcdoc, BOARD_CSP, themeCss, setBoardFrameUrl, boardFrameUrl, FRAME_READY, FRAME_BOOT } from './frame'
export { parseBoardEmbed, renderBoardEmbed, BOARD_EMBED_RE } from './embed'
export { createBoardView } from './view'
export { BOARD_TEMPLATE } from './template'

export function createBoardPlugin(): VaultPlugin {
  let api: PluginAPI | undefined
  return {
    manifest: {
      id: 'plugin-board',
      name: 'Boards',
      version: '0.0.1',
      description: 'Des mini applis en HTML, CSS et JavaScript qui interrogent les bases (fichiers .board)',
      scope: 'vault',
      permissions: ['ui:editor', 'vault:read', 'vault:write'],
      // Actif dans toutes les notes : ![[x.board]].
      defaultActive: true,
    },
    async onload(pluginApi: PluginAPI) {
      api = pluginApi
      pluginApi.files.register({
        extension: 'board',
        label: 'Board',
        icon: 'layout-dashboard',
        // Le code est un texte partage : edition a plusieurs, sans verrou.
        collaborationMode: 'crdt',
        creatable: true,
        create: async () => '',
        open: (path: string, ctx: FileContext) => createBoardView(path, ctx, api),
      })
      pluginApi.blocks?.register({
        type: 'board-embed',
        detect: (text: string) => parseBoardEmbed(text) !== null,
        deserialize: (raw: string) => String(raw).trim(),
        serialize: (data: unknown) => String(data),
        createEditorWidget: () => ({ mount: () => {}, destroy: () => {} }),
        renderClient: (data: unknown) => {
          const name = parseBoardEmbed(String(data))
          return name ? renderBoardEmbed(name, api) : document.createElement('div')
        },
      })
    },
    async onunload() {
      api?.files.unregister('board')
      api?.blocks?.unregister('board-embed')
      api = undefined
    },
  }
}

const plugin = createBoardPlugin()
export default plugin
