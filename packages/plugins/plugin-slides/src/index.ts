// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Presentations : le format (note `type: slides`) et son rendu sont dans
// l'editeur (editor-core, plugin-api/slides.ts). Ce plugin donne aux IA
// (dans l'appli et par le MCP du serveur) de quoi lire le plan d'une
// presentation et regler son allure.
import type { VaultPlugin } from '@savoire/plugin-api'
import { slidesAgentTools } from './agentTools'
import { SLIDES_MANIFEST } from './manifest'

export { slidesAgentTools } from './agentTools'
export { SLIDES_MANIFEST } from './manifest'

export function createSlidesPlugin(): VaultPlugin {
  return {
    manifest: SLIDES_MANIFEST,
    async onload(api) {
      for (const tool of slidesAgentTools(api)) api.agents?.registerTool(tool)
    },
    async onunload() {},
  }
}

export default createSlidesPlugin()
