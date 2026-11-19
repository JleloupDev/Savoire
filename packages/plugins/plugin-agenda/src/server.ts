// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Le plugin Agenda sur le pair indexeur (ADR-033) : ses outils d'agent seuls,
// sans le calendrier (React). Voir apps/indexer/src/serverPlugins.ts.
import type { PluginAPI, PluginManifest, VaultPlugin } from '@savoire/plugin-api'
import { agendaAgentTools } from './agentTools'

export const AGENDA_MANIFEST: PluginManifest = {
  id: 'plugin-agenda',
  name: 'Agenda',
  version: '0.0.1',
  description: 'Un calendrier et une note par jour (Journal/AAAA-MM-JJ.md), avec le modèle « Note du jour »',
  scope: 'vault',
  permissions: ['ui:editor', 'vault:read', 'vault:write', 'agents'],
  defaultActive: true,
  official: true,
}

/** Tous les fichiers du vault (chemins). */
export async function allFiles(api: PluginAPI): Promise<string[]> {
  const files: string[] = []
  const queue = ['']
  while (queue.length) {
    const dir = queue.shift()!
    for (const entry of await api.vault.list(dir || undefined)) {
      if (entry.endsWith('/')) { if (entry !== dir) queue.push(entry) }
      else files.push(entry)
    }
  }
  return files
}

const serverPlugin: VaultPlugin = {
  manifest: AGENDA_MANIFEST,
  async onload(api) {
    for (const tool of agendaAgentTools(api, () => allFiles(api))) api.agents?.registerTool(tool)
  },
  async onunload() {},
}

export default serverPlugin
