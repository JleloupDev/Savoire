// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import type { VaultPlugin, PluginAPI } from '@savoire/plugin-api'
import { BacklinksIndexContributor } from './BacklinksIndexContributor'
import { BacklinksWidget } from './BacklinksWidget'

export function createBacklinksPlugin(options: {
  tabOf?: string
  initialSize?: number
} = {}): VaultPlugin {
  const contributor = new BacklinksIndexContributor()

  return {
    manifest: {
      id: 'plugin-backlinks',
      name: 'Backlinks',
      version: '0.0.1',
      description: 'Affiche les documents qui pointent vers le document courant.',
      permissions: ['vault:read', 'ui:editor'],
    },

    async onload(api: PluginAPI) {
      // Enregistre le contributeur dans l'index local
      api.index?.register(contributor)

      api.views.register({
        id: 'backlinks',
        title: 'Backlinks',
        icon: 'link',
        container: 'right',
        tabOf: options.tabOf,
        initialSize: options.initialSize ?? 280,
        closable: true,
        createView(ctx) {
          return new BacklinksWidget(ctx, contributor)
        },
      })
    },

    async onunload() {},
  }
}

export { BacklinksWidget } from './BacklinksWidget'
export { BacklinksIndexContributor } from './BacklinksIndexContributor'
