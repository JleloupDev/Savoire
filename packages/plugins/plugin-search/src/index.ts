// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import type { VaultPlugin, PluginAPI } from '@savoire/plugin-api'
import { FullTextIndexContributor } from './FullTextIndexContributor'
import { SearchWidget } from './SearchWidget'

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
      name: 'Recherche',
      version: '0.0.1',
      description: 'Recherche full-text dans tous les documents du vault.',
      permissions: ['vault:read', 'ui:editor'],
    },

    async onload(api: PluginAPI) {
      api.index?.registerFactory(() => { current = new FullTextIndexContributor(); return current })

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
          return new SearchWidget(ctx, () => current)
        },
      })

      // Ctrl+Shift+F — ouvre le panneau et focus l'input.
      // keybinding global géré dans l'app shell (Option A — voir TODO plugin API keybindings).
      api.commands.register({
        id: 'search:open',
        label: 'Rechercher dans le vault',
        run() {
          api.workspace.openPanel('search')
        },
      })
    },

    async onunload() {},
  }

  return { plugin, getContributor: () => current }
}

export { FullTextIndexContributor } from './FullTextIndexContributor'
export type { FullTextSearchResult } from './FullTextIndexContributor'
export { SearchWidget } from './SearchWidget'
