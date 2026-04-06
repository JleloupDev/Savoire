// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// pluginRegistry.ts — registre des plugins optionnels (chargés par note-scope ou extension).

import type { VaultPlugin } from '@savoire/plugin-api'

// Static registery of plugin, to be replaced by a dynamic discovery mechanism int the future
// Core plugins could be still registered by a static system.
export const pluginRegistry: Record<string, () => Promise<VaultPlugin>> = {
  // Workspace plugins — file-type handlers, loaded lazily by extension
  'plugin-excalidraw':  () => import('@savoire/plugin-excalidraw').then(m => m.default),
  'plugin-mindmap':     () => import('@savoire/plugin-mindmap').then(m => m.default),
  // Editor plugins — used when activating via frontmatter in standalone mode
  // (in shared API mode, activateScopedPlugin() skips the load if already registered)
  'plugin-mermaid':     () => import('@savoire/plugin-mermaid').then(m => m.default),
  'plugin-callout':     () => import('@savoire/plugin-callout').then(m => m.default),
  'plugin-code-block':  () => import('@savoire/plugin-code-block').then(m => m.default),
  'plugin-wikilinks':   () => import('@savoire/plugin-wikilinks').then(m => m.default),
  'plugin-note-embed':  () => import('@savoire/plugin-note-embed').then(m => m.default),
  'plugin-module':      () => import('@savoire/plugin-module').then(m => m.default),
  'plugin-task-list':   () => import('@savoire/plugin-task-list').then(m => m.default),
  'plugin-table':       () => import('@savoire/plugin-table').then(m => m.default),
}
