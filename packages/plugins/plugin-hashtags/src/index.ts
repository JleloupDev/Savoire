// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import type { VaultPlugin, PluginAPI } from '@savoire/plugin-api'
import { HashtagIndexContributor } from './HashtagIndexContributor'
import { HashtagsWidget } from './HashtagsWidget'

export function createHashtagsPlugin(options: {
  tabOf?: string
  belowOf?: string
  initialSize?: number
} = {}): VaultPlugin {
  return {
    manifest: {
      id: 'plugin-hashtags',
      name: 'Hashtags',
      version: '0.0.1',
      description: 'Indexe les hashtags et affiche les documents associés.',
      permissions: ['vault:read', 'ui:editor'],
    },

    async onload(api: PluginAPI) {
      let current = new HashtagIndexContributor()
      api.index?.registerFactory(() => { current = new HashtagIndexContributor(); return current })

      api.views.register({
        id: 'hashtags',
        title: 'Hashtags',
        icon: 'hash',
        container: 'right',
        tabOf: options.tabOf,
        belowOf: options.belowOf,
        initialSize: options.initialSize ?? 280,
        closable: true,
        createView(ctx) {
          return new HashtagsWidget(ctx, () => current)
        },
      })
    },

    async onunload() {},
  }
}

export { HashtagIndexContributor } from './HashtagIndexContributor'
export { HashtagsWidget } from './HashtagsWidget'
