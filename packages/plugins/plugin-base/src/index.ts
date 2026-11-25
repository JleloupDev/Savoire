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
import type { BlockContext, FileContext, PluginAPI, VaultPlugin } from '@savoire/plugin-api'
import { activeBaseView, createBaseView } from './view'
import { BASE_QUERY_FENCE_RE, renderBaseQueryBlock } from './queryBlock'
import { ensureStyle } from './style'
import { parseBaseEmbed, renderBaseEmbed } from './embed'
import { canLinkView, renderLinkedView } from './linkedView'
import { cellProposalType } from './proposals'
import { baseAgentTools } from './agentTools'
import { BASE_PLUGIN_MANIFEST } from './pluginManifest'

export { createBaseView } from './view'
export type { BaseViewOptions, EmbeddedOptions } from './view'
export { renderLinkedView, retargetEmbed, canLinkView } from './linkedView'
export { ManifestStore, readManifest, defaultManifest, defaultView, TITLE_COLUMN } from './manifest'
export type { BaseManifest, BaseViewDef, BaseFilter, BaseFilterGroup, BaseFilterItem, FilterMode, BaseSort, BaseColumn } from './manifest'
export { LightRows, readRow } from './rows'
export type { LightRow } from './rows'
export { parseBaseQuery, evaluateBaseQuery, enginePlan, BASE_QUERY_FENCE_RE, renderBaseQueryBlock, resolveBase } from './queryBlock'
export { toSort } from './view'
export { toWhere, readFilters, countFilters, rangeOf, dayOf, DATE_RANGES, RELATIVE_DAYS, ME } from './filters'
export type { FilterContext, BaseFilterOp } from './filters'
export type { BaseQuery, BaseQueryResult } from './queryBlock'
export { parseBaseEmbed, renderBaseEmbed, embedQuery, BASE_EMBED_RE } from './embed'
export { createPageRow, folderOfBase, uniqueNotePath, writeNoteProperty, renamePageRow } from './notes'
export { ROW_HEIGHT, PAGE_SIZE } from './table'
export { CELL_PROPOSAL, cellProposalType } from './proposals'
export { baseAgentTools } from './agentTools'
export { parseFilter, parseSorts, parseCell, FILTER_OPS } from './agentArgs'
export { BASE_PLUGIN_MANIFEST } from './pluginManifest'
export type { CellProposal } from './proposals'
export { withFormulas, clientFormulas, toEngineQuery, needsFormulas, splitWhere } from './formulaEngine'
export { computeTotal, totalText, TOTAL_KINDS } from './totals'
export { orderGroups, groupLabel, groupField, DATE_GROUPINGS } from './groups'
export { shiftDate, monthGrid } from './views/calendar'
export { parseCsv, toCsv, parseCellText } from './csv'
export { periodOf, dueTemplates, triggered, actionValues, onAdded } from './structure'
export type { ActionDef, AutomationDef, ButtonDef, TemplateSettings } from './structure'
export type { DateGrouping } from './groups'
export type { TotalKind } from './totals'

export function createBasePlugin(): VaultPlugin {
  let api: PluginAPI | undefined
  return {
    manifest: BASE_PLUGIN_MANIFEST,

    async onload(pluginApi: PluginAPI) {
      api = pluginApi
      // Revision : une valeur de cellule proposee (mode suggestion), appliquee a l'acceptation.
      pluginApi.review?.registerProposalType(cellProposalType(pluginApi))
      // Agents (ADR-033) : creer, decrire, interroger et modifier les bases (aussi sur le pair, pour ChatGPT et Claude).
      for (const tool of baseAgentTools(pluginApi)) pluginApi.agents?.registerTool(tool)
      pluginApi.files.register({
        extension: 'base',
        label: 'Base',
        icon: 'database',
        // Le manifeste est un arbre partage : edition simultanee, sans verrou.
        collaborationMode: 'crdt',
      // Contenu : un arbre (ctx.tree). Sur le disque : son JSON.
      crdtRoot: 'tree',
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
          icon: 'database',
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
        renderClient: (data: unknown, ctx?: BlockContext) => {
          ensureStyle()
          const target = parseBaseEmbed(String(data))
          if (!target) return document.createElement('div')
          // Dans une note modifiable : la vue liee, modifiable sur place ; sinon la lecture seule.
          return api && canLinkView(api, ctx) ? renderLinkedView(target, api, ctx!) : renderBaseEmbed(target, api)
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
