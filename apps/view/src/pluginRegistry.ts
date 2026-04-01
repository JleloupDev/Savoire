// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import type { VaultPlugin } from '@savoire/plugin-api'

export const pluginRegistry: Record<string, () => Promise<VaultPlugin>> = {
  'plugin-excalidraw': () => import('@savoire/plugin-excalidraw').then(m => m.default),
  'plugin-mindmap': () => import('@savoire/plugin-mindmap').then(m => m.default),
  'plugin-mermaid': () => import('@savoire/plugin-mermaid').then(m => m.default),
  'plugin-callout': () => import('@savoire/plugin-callout').then(m => m.default),
  'plugin-code-block': () => import('@savoire/plugin-code-block').then(m => m.default),
  'plugin-wikilinks': () => import('@savoire/plugin-wikilinks').then(m => m.default),
  'plugin-note-embed': () => import('@savoire/plugin-note-embed').then(m => m.default),
  'plugin-module': () => import('@savoire/plugin-module').then(m => m.default),
  'plugin-task-list': () => import('@savoire/plugin-task-list').then(m => m.default),
  'plugin-table': () => import('@savoire/plugin-table').then(m => m.default),
  'plugin-plaintext': () => import('@savoire/plugin-plaintext').then(m => m.default),
}
