// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Plugin core « Rétroliens » : le panneau des notes qui pointent vers la note
// ouverte. Il lit l'index de tout le vault quand il existe (pair indexeur,
// index local du bureau), sinon son propre index partage ('backlinks') des
// notes deja indexees. Le desactiver retire le panneau, pas les liens.
import type { VaultPlugin, PluginAPI } from '@savoire/plugin-api'
import { BacklinksWidget } from './BacklinksWidget'
import { BacklinksIndexContributor } from './BacklinksIndexContributor'

export function createBacklinksPlugin(options: {
  groupId?: string
  tabOf?: string
  belowOf?: string
  initialSize?: number
} = {}): VaultPlugin {
  return {
    manifest: {
      id: 'plugin-backlinks',
      scope: 'vault',
      name: 'Rétroliens',
      version: '0.0.2',
      description: 'Les notes qui pointent vers la note ouverte',
      permissions: ['vault:read'],
      defaultActive: true,
    },

    async onload(api: PluginAPI) {
      const links = new BacklinksIndexContributor()
      api.index?.registerFactory(() => links)
      api.views.register({
        id: 'backlinks',
        title: 'Backlinks',
        icon: 'link',
        groupId: options.groupId,
        container: 'right',
        tabOf: options.tabOf,
        belowOf: options.belowOf,
        initialSize: options.initialSize ?? 280,
        closable: true,
        createView(ctx) {
          return new BacklinksWidget(ctx, links, api.indexer)
        },
      })
    },

    async onunload() {},
  }
}

export { BacklinksIndexContributor } from './BacklinksIndexContributor'
export { BacklinksWidget, type BacklinkSource } from './BacklinksWidget'
export type { BacklinkEntry } from './BacklinksIndexContributor'
