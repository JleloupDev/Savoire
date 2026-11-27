// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Applications sur le pair indexeur (ADR-033) : les outils d'agent seuls,
// sans la vue (elle a besoin d'une page). Voir apps/indexer/src/serverPlugins.ts.
import type { VaultPlugin } from '@savoire/plugin-api'
import { appAgentTools } from './agentTools'
import { APP_MANIFEST } from './manifest'

const serverPlugin: VaultPlugin = {
  manifest: APP_MANIFEST,
  async onload(api) {
    for (const tool of appAgentTools(api)) api.agents?.registerTool(tool)
  },
  async onunload() {},
}

export default serverPlugin
