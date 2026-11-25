// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import type { PluginManifest } from '@savoire/plugin-api'

export const SLIDES_MANIFEST: PluginManifest = {
  id: 'plugin-slides',
  name: 'Présentations',
  version: '0.0.1',
  description: 'Les outils des IA pour les présentations (notes type: slides) : plan, transitions, apparitions, décor, images de fond',
  scope: 'vault',
  permissions: ['vault:read', 'vault:write', 'agents'],
  defaultActive: true,
  // Livre avec Savoire : ses outils tournent aussi sur le pair indexeur (MCP).
  official: true,
}
