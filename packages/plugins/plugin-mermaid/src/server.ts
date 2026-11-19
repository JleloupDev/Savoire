// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Mermaid sur le pair indexeur (ADR-033) : l'outil d'agent seul, sans le
// rendu (la bibliotheque mermaid a besoin d'une page). Voir
// apps/indexer/src/serverPlugins.ts.
import type { PluginManifest, VaultPlugin } from '@savoire/plugin-api'
import { mermaidAgentTools } from './agentTools'

export const MERMAID_MANIFEST: PluginManifest = {
  id: 'plugin-mermaid',
  scope: 'personal',
  name: 'Mermaid Diagrams',
  version: '0.0.1',
  description: 'Rendu de diagrammes Mermaid dans l\'éditeur',
  permissions: ['ui:editor', 'vault:read', 'vault:write', 'agents'],
  defaultActive: true,
  official: true,
}

const serverPlugin: VaultPlugin = {
  manifest: MERMAID_MANIFEST,
  async onload(api) {
    for (const tool of mermaidAgentTools(api)) api.agents?.registerTool(tool)
  },
  async onunload() {},
}

export default serverPlugin
