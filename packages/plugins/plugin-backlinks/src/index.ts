// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import type { VaultPlugin, PluginAPI } from '@savoire/plugin-api'
import { BacklinksIndexContributor } from './BacklinksIndexContributor'

// DECISION: view moved to plugin-wikilinks — backlinks panel is now provided by
// the wikilinks plugin which owns the contributor. This package keeps the contributor
// for backward compatibility with existing snapshots that reference namespace 'backlinks'.
export function createBacklinksPlugin(_options: {
  tabOf?: string
  belowOf?: string
  initialSize?: number
} = {}): VaultPlugin {
  return {
    manifest: {
      id: 'plugin-backlinks',
      name: 'Backlinks',
      version: '0.0.1',
      description: 'Indexe les backlinks (vue fournie par plugin-wikilinks).',
      permissions: ['vault:read'],
    },

    async onload(api: PluginAPI) {
      api.index?.registerFactory(() => new BacklinksIndexContributor())
    },

    async onunload() {},
  }
}

export { BacklinksIndexContributor } from './BacklinksIndexContributor'
