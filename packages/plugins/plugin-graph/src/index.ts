// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import type { VaultPlugin, PluginAPI } from '@savoire/plugin-api'
import { GraphIndexContributor } from './GraphIndexContributor'
import { GraphWidget } from './GraphWidget'

export interface GraphPluginHandle {
  plugin: VaultPlugin
  /** Always returns the current contributor instance (rebuilt on each vault switch). */
  getContributor: () => GraphIndexContributor
}

export function createGraphPlugin(options: { groupId?: string; tabOf?: string } = {}): GraphPluginHandle {
  let current = new GraphIndexContributor()

  const plugin: VaultPlugin = {
    manifest: {
      id: 'plugin-graph',
      name: 'Graphe de notes',
      version: '0.0.1',
      description: 'Visualise les dépendances entre notes via les wikilinks.',
      permissions: ['vault:read', 'ui:editor'],
    },

    async onload(api: PluginAPI) {
      api.index?.registerFactory(() => { current = new GraphIndexContributor(); return current })

      api.views.register({
        id: 'graph',
        title: 'Graphe',
        icon: 'git-fork',
        // Vue principale, pas un panneau lateral : un graphe de vault a besoin
        // de place. `ribbon` pose le bouton d'ouverture dans la barre d'icones
        // de gauche. groupId/tabOf restent honores si un hote veut malgre tout
        // l'ancrer dans un groupe.
        groupId: options.groupId,
        container: options.groupId ? undefined : 'center',
        tabOf: options.tabOf,
        ribbon: true,
        closable: true,
        createView(ctx) {
          return new GraphWidget(ctx, () => current)
        },
      })
    },

    async onunload() {},
  }

  return { plugin, getContributor: () => current }
}

export { GraphIndexContributor } from './GraphIndexContributor'
