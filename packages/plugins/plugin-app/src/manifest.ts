// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import type { PluginManifest } from '@savoire/plugin-api'

export const APP_MANIFEST: PluginManifest = {
  id: 'plugin-app',
  name: 'Applications',
  version: '0.0.1',
  description: 'Des applications dans le vault (fichiers .app) : React fourni, fichiers de leur dossier, plein écran ; fichiers de code et de données (JSON, JS, CSS)',
  scope: 'vault',
  permissions: ['ui:editor', 'vault:read', 'vault:write'],
  official: true,
}
