// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Presentations sur le pair indexeur (ADR-033) : les outils d'agent. Voir
// apps/indexer/src/serverPlugins.ts.
import type { VaultPlugin } from '@savoire/plugin-api'
import { slidesAgentTools } from './agentTools'
import { SLIDES_MANIFEST } from './manifest'

const serverPlugin: VaultPlugin = {
  manifest: SLIDES_MANIFEST,
  async onload(api) {
    for (const tool of slidesAgentTools(api)) api.agents?.registerTool(tool)
  },
  async onunload() {},
}

export default serverPlugin
