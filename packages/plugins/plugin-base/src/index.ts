// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// plugin-base — des bases facon Notion (fichiers .base). Voir ADR-027.
//
// Une base est un MANIFESTE (le document .base, en arbre partage : source,
// colonnes, vues), et des lignes de deux sortes :
//  - lignes-pages : les notes du dossier de la base, valeurs en frontmatter ;
//  - lignes legeres : sans note, rangees dans des lots (arbres annexes du
//    document), pour les bases de dizaines de milliers de lignes ; une ligne
//    legere peut etre promue en page.
// Toutes les lectures passent par api.query ; les types des proprietes sont
// ceux du vault (api.properties). Tout s'edite a plusieurs en temps reel.
import type { FileContext, PluginAPI, VaultPlugin } from '@savoire/plugin-api'
import { activeBaseView, createBaseView } from './view'

export { createBaseView } from './view'
export { ManifestStore, readManifest, defaultManifest, TITLE_COLUMN } from './manifest'
export type { BaseManifest, BaseViewDef, BaseFilter, BaseSort, BaseColumn } from './manifest'
export { LightRows, readRow } from './rows'
export type { LightRow } from './rows'
export { createPageRow, folderOfBase, uniqueNotePath, writeNoteProperty, renamePageRow } from './notes'
export { ROW_HEIGHT, PAGE_SIZE } from './table'

export function createBasePlugin(): VaultPlugin {
  let api: PluginAPI | undefined
  return {
    manifest: {
      id: 'plugin-base',
      name: 'Bases',
      version: '0.0.1',
      description: 'Des bases façon Notion : tableau, kanban, propriétés typées (fichiers .base)',
      scope: 'vault',
      permissions: ['ui:editor', 'vault:read', 'vault:write'],
    },

    async onload(pluginApi: PluginAPI) {
      api = pluginApi
      pluginApi.files.register({
        extension: 'base',
        label: 'Base',
        icon: '🗃️',
        // Le manifeste est un arbre partage : edition simultanee, sans verrou.
        collaborationMode: 'crdt',
        creatable: true,
        // Un document crdt neuf commence vide : la vue pose la structure a la
        // premiere modification (voir docs/Architecture/plugin-crdt-api.md).
        create: async () => '',
        open: (path: string, ctx: FileContext) => createBaseView(path, ctx, api),
      })
      // Raccourcis possibles : par le moteur de commandes, jamais par un
      // gestionnaire de touches propre au plugin.
      pluginApi.commands?.register({
        id: 'base:new-page',
        label: 'Base : nouvelle ligne-page',
        run: () => { void activeBaseView?.addPage() },
      })
      pluginApi.commands?.register({
        id: 'base:new-row',
        label: 'Base : nouvelle ligne légère',
        run: () => { void activeBaseView?.addLightRow() },
      })
    },

    async onunload() {
      api = undefined
    },
  }
}

const plugin = createBasePlugin()
export default plugin
