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
import { BASE_QUERY_FENCE_RE, renderBaseQueryBlock } from './queryBlock'
import { ensureStyle } from './style'
import { parseBaseEmbed, renderBaseEmbed } from './embed'

export { createBaseView } from './view'
export { ManifestStore, readManifest, defaultManifest, TITLE_COLUMN } from './manifest'
export type { BaseManifest, BaseViewDef, BaseFilter, BaseSort, BaseColumn } from './manifest'
export { LightRows, readRow } from './rows'
export type { LightRow } from './rows'
export { parseBaseQuery, evaluateBaseQuery, enginePlan, BASE_QUERY_FENCE_RE, renderBaseQueryBlock, resolveBase } from './queryBlock'
export { toWhere, toSort } from './view'
export type { BaseQuery, BaseQueryResult } from './queryBlock'
export { parseBaseEmbed, renderBaseEmbed, embedQuery, BASE_EMBED_RE } from './embed'
export { createPageRow, folderOfBase, uniqueNotePath, writeNoteProperty, renamePageRow } from './notes'
export { ROW_HEIGHT, PAGE_SIZE } from './table'
export { withFormulas, needsFormulas, splitWhere } from './formulaEngine'
export { computeTotal, totalText, TOTAL_KINDS } from './totals'
export type { TotalKind } from './totals'

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
      // Actif dans toutes les notes : blocs ```base et ![[x.base]].
      defaultActive: true,
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
      // Bloc de requete dans une note : ```base ... ``` (queryBlock.ts).
      pluginApi.blocks?.register({
        type: 'base-query',
        trigger: {
          id: 'base-query',
          label: 'Requête sur une base',
          description: 'Bloc from / where / select (sum, count…)',
          icon: '🗃️',
          category: 'Bases',
          insert: '```base\nfrom Projets.base\nwhere prop("Statut") == "Fait"\nselect sum(prop("Prix")) as "Total", count()\n```',
        },
        detect: (text: string) => BASE_QUERY_FENCE_RE.test(text.trim()),
        deserialize: (raw: string) => BASE_QUERY_FENCE_RE.exec(String(raw).trim())?.[1] ?? '',
        serialize: (data: unknown) => `\`\`\`base\n${String(data)}\n\`\`\``,
        createEditorWidget: () => ({ mount: () => {}, destroy: () => {} }),
        renderClient: (data: unknown) => { ensureStyle(); return renderBaseQueryBlock(String(data), api) },
      })
      // Base integree dans une note : ![[db.base]] ou ![[db.base#Vue]] (embed.ts).
      pluginApi.blocks?.register({
        type: 'base-embed',
        detect: (text: string) => parseBaseEmbed(text) !== null,
        deserialize: (raw: string) => String(raw).trim(),
        serialize: (data: unknown) => String(data),
        createEditorWidget: () => ({ mount: () => {}, destroy: () => {} }),
        renderClient: (data: unknown) => {
          ensureStyle()
          const target = parseBaseEmbed(String(data))
          return target ? renderBaseEmbed(target, api) : document.createElement('div')
        },
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
