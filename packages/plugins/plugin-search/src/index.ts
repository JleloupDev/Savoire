// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import type { ISearchEngine, IndexState, SearchHit, VaultPlugin, PluginAPI } from '@savoire/plugin-api'
import { FullTextIndexContributor } from './FullTextIndexContributor'
import { SearchWidget } from './SearchWidget'

const DEGRADED: IndexState = { status: 'unavailable' }

/**
 * Hote sans api.search (page de partage, anciens hotes) : le plein texte
 * local des notes ouvertes, sans extraits ni pages. L'appli, elle, en fait
 * le secours de api.search (FullTextFallbackSearch).
 */
function contributorEngine(get: () => FullTextIndexContributor, api: PluginAPI): ISearchEngine {
  return {
    async search(query) {
      const text = query.text.trim()
      if (!text) return { hits: [], total: 0, index: DEGRADED }
      const hits: SearchHit[] = get().search(text)
        .filter(r => r.path && !r.path.startsWith('.trash/') && !api.vault.isTrashed?.(r.docId))
        .map(r => ({
          id: r.docId,
          path: r.path,
          title: (r.path.split('/').at(-1) ?? r.path).replace(/\.[^.]+$/, ''),
          score: r.score,
          snippets: [],
        }))
      return { hits: hits.slice(0, query.limit ?? 50), total: hits.length, index: DEGRADED }
    },
    state: () => DEGRADED,
    onStateChange: () => () => {},
  }
}

export function createSearchPlugin(options: {
  groupId?: string
  tabOf?: string
  belowOf?: string
  initialSize?: number
  ribbon?: boolean
  container?: 'left' | 'right'
} = {}): { plugin: VaultPlugin; getContributor: () => FullTextIndexContributor } {
  let current = new FullTextIndexContributor()

  const plugin: VaultPlugin = {
    manifest: {
      id: 'plugin-search',
      scope: 'personal',
      name: 'Recherche',
      version: '0.0.2',
      description: 'Recherche plein texte dans tout le vault (extraits, sections), ou dans tous vos vaults.',
      permissions: ['vault:read', 'ui:editor'],
    },

    async onload(api: PluginAPI) {
      // Le plein texte local reste indexe : c'est le secours de api.search.
      api.index?.registerFactory(() => { current = new FullTextIndexContributor(); return current })
      const engine = api.search ?? contributorEngine(() => current, api)
      // Lien entre les commandes et le panneau monte.
      const shared: { onGlobal?: (on: boolean) => void; wantGlobal?: boolean } = {}

      api.views.register({
        id: 'search',
        title: 'Recherche',
        icon: 'search',
        ribbon: options.ribbon,
        groupId: options.groupId,
        container: options.container ?? 'left',
        tabOf: options.tabOf,
        belowOf: options.belowOf,
        initialSize: options.initialSize ?? 280,
        closable: true,
        createView(ctx) {
          return new SearchWidget(ctx, engine, shared)
        },
      })

      // Ctrl+Maj+F (Cmd+Maj+F sur Mac) : ouvre le panneau de recherche.
      api.commands.register({
        id: 'search:open',
        label: 'Rechercher dans le vault',
        hotkeys: [{ modifiers: ['Mod', 'Shift'], key: 'f' }],
        run() {
          api.workspace.openPanel('search')
          shared.onGlobal?.(false)
        },
      })

      // Ctrl+Alt+Maj+F : la meme, dans tous les vaults (si le profil l'offre).
      api.commands.register({
        id: 'search:all-vaults',
        label: 'Rechercher dans tous mes vaults',
        hotkeys: [{ modifiers: ['Mod', 'Alt', 'Shift'], key: 'f' }],
        run() {
          shared.wantGlobal = true
          api.workspace.openPanel('search')
          shared.onGlobal?.(true)
        },
      })
    },

    async onunload() {},
  }

  return { plugin, getContributor: () => current }
}

export { FullTextIndexContributor } from './FullTextIndexContributor'
export type { FullTextSearchResult } from './FullTextIndexContributor'
export { SearchWidget, SearchPanel, describeSearchState, SEARCH_PAGE_SIZE } from './SearchWidget'
