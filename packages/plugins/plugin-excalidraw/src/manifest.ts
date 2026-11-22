// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Manifeste d'Excalidraw, le meme dans l'appli (index.tsx) et sur le pair
// indexeur (server.ts).
import type { PluginManifest } from '@savoire/plugin-api'

export const EXCALIDRAW_MANIFEST: PluginManifest = {
  id: 'plugin-excalidraw',
  scope: 'vault',
  name: 'Excalidraw',
  version: '0.0.2',
  description: 'Éditeur de dessin vectoriel Excalidraw pour les fichiers .excalidraw',
  permissions: ['ui:editor', 'vault:read', 'vault:write', 'agents'],
  defaultActive: false,
  // Plugin du store (pas livre d'office), relu par l'equipe Savoire.
  trust: 'verified',
}
