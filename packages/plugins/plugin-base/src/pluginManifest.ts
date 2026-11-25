// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Manifeste du plugin Bases, le meme dans l'appli (index.ts) et sur le pair
// indexeur (server.ts). A ne pas confondre avec manifest.ts : le contenu
// d'un document .base.
import type { PluginManifest } from '@savoire/plugin-api'

export const BASE_PLUGIN_MANIFEST: PluginManifest = {
  id: 'plugin-base',
  name: 'Bases',
  version: '0.0.1',
  description: 'Des bases façon Notion : tableau, kanban, propriétés typées (fichiers .base)',
  scope: 'vault',
  permissions: ['ui:editor', 'vault:read', 'vault:write', 'agents'],
  // Actif dans toutes les notes : blocs ```base et ![[x.base]].
  defaultActive: true,
  // Livre avec Savoire : ses outils d'agent tournent aussi sur le pair indexeur.
  official: true,
}
