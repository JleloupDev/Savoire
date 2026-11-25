// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Animations sur le pair indexeur (ADR-033) : les outils d'agent seuls, sans
// le lecteur (il a besoin d'une page). Voir apps/indexer/src/serverPlugins.ts.
import type { VaultPlugin } from '@savoire/plugin-api'
import { animationAgentTools } from './agentTools'
import { ANIMATION_MANIFEST } from './manifest'

const serverPlugin: VaultPlugin = {
  manifest: ANIMATION_MANIFEST,
  async onload(api) {
    for (const tool of animationAgentTools(api)) api.agents?.registerTool(tool)
  },
  async onunload() {},
}

export default serverPlugin
