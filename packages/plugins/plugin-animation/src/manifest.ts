// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import type { PluginManifest } from '@savoire/plugin-api'

export const ANIMATION_MANIFEST: PluginManifest = {
  id: 'plugin-animation',
  name: 'Animations',
  version: '0.0.1',
  description: 'Des animations en code avec anime.js (fichiers .anim), intégrables dans les notes et les diapositives, commentées au timecode',
  scope: 'vault',
  permissions: ['ui:editor', 'vault:read', 'vault:write', 'agents'],
  // Actif dans toutes les notes : ![[x.anim]].
  defaultActive: true,
  // Livre avec Savoire : ses outils tournent aussi sur le pair indexeur.
  official: true,
}
