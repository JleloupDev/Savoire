// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Excalidraw sur le pair indexeur (ADR-033) : les outils d'agent seuls, sans
// l'editeur (React et Excalidraw ont besoin d'une page). ChatGPT et Claude
// lisent et modifient les dessins par le MCP du serveur. Voir
// apps/indexer/src/serverPlugins.ts.
import type { VaultPlugin } from '@savoire/plugin-api'
import { excalidrawAgentTools } from './agentTools'
import { EXCALIDRAW_MANIFEST } from './manifest'

const serverPlugin: VaultPlugin = {
  manifest: EXCALIDRAW_MANIFEST,
  async onload(api) {
    for (const tool of excalidrawAgentTools(api)) api.agents?.registerTool(tool)
  },
  async onunload() {},
}

export default serverPlugin
