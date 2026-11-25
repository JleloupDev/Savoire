// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Les bases sur le pair indexeur (ADR-033) : les outils d'agent seuls, sans
// la vue (elle a besoin d'une page). ChatGPT et Claude creent, lisent,
// interrogent et modifient les bases par le MCP du serveur. Voir
// apps/indexer/src/serverPlugins.ts.
import type { VaultPlugin } from '@savoire/plugin-api'
import { baseAgentTools } from './agentTools'
import { BASE_PLUGIN_MANIFEST } from './pluginManifest'

const serverPlugin: VaultPlugin = {
  manifest: BASE_PLUGIN_MANIFEST,
  async onload(api) {
    for (const tool of baseAgentTools(api)) api.agents?.registerTool(tool)
  },
  async onunload() {},
}

export default serverPlugin
