// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import type { VaultPlugin, PluginAPI } from '@savoire/plugin-api'
import { MetadataWidget } from './MetadataWidget'

export function createMetadataPlugin(options: {
  tabOf?: string
} = {}): VaultPlugin {
  return {
    manifest: {
      id: 'plugin-metadata',
      name: 'Métadonnées',
      version: '0.0.1',
      description: 'Affiche les métadonnées indexées du document courant.',
      permissions: ['vault:read', 'ui:editor'],
    },

    async onload(api: PluginAPI) {
      api.views.register({
        id: 'metadata',
        title: 'Métadonnées',
        icon: 'tag',
        container: 'right',
        tabOf: options.tabOf,
        initialSize: 280,
        closable: true,
        createView(ctx) {
          return new MetadataWidget(ctx, api.vault)
        },
      })
    },

    async onunload() {},
  }
}

export { MetadataWidget } from './MetadataWidget'
