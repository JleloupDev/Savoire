// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Les hashtags sur le pair indexeur (ADR-033) : les outils d'agent seuls,
// sans le panneau (React). Voir apps/indexer/src/serverPlugins.ts.
import type { PluginManifest, VaultPlugin } from '@savoire/plugin-api'
import { hashtagAgentTools } from './agentTools'

export const HASHTAGS_MANIFEST: PluginManifest = {
  id: 'plugin-hashtags',
  scope: 'vault',
  name: 'Hashtags',
  version: '0.0.1',
  description: 'Indexe les hashtags et affiche les documents associés.',
  permissions: ['vault:read', 'ui:editor', 'vault:write', 'agents'],
  official: true,
}

const serverPlugin: VaultPlugin = {
  manifest: HASHTAGS_MANIFEST,
  async onload(api) {
    for (const tool of hashtagAgentTools(api)) api.agents?.registerTool(tool)
  },
  async onunload() {},
}

export default serverPlugin
