// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import type { VaultPlugin, PluginAPI } from '@savoire/plugin-api'
import { GraphIndexContributor } from './GraphIndexContributor'
import { GraphWidget } from './GraphWidget'

export interface GraphPluginHandle {
  plugin: VaultPlugin
  /** Contributor exposé pour permettre un bulkLoad au chargement du vault. */
  contributor: GraphIndexContributor
}

export function createGraphPlugin(options: { tabOf?: string } = {}): GraphPluginHandle {
  const contributor = new GraphIndexContributor()

  const plugin: VaultPlugin = {
    manifest: {
      id: 'plugin-graph',
      name: 'Graphe de notes',
      version: '0.0.1',
      description: 'Visualise les dépendances entre notes via les wikilinks.',
      permissions: ['vault:read', 'ui:editor'],
    },

    async onload(api: PluginAPI) {
      // Register the index contributor so it receives onOp events
      api.index?.register(contributor)

      api.views.register({
        id: 'graph',
        title: 'Graphe',
        icon: 'git-fork',
        container: 'right',
        tabOf: options.tabOf,
        initialSize: 320,
        closable: true,
        createView(ctx) {
          return new GraphWidget(ctx, contributor)
        },
      })
    },

    async onunload() {},
  }

  return { plugin, contributor }
}

export { GraphIndexContributor } from './GraphIndexContributor'
