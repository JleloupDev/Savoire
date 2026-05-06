// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import type { VaultPlugin, PluginAPI } from '@savoire/plugin-api'
import { FileTreeWidget } from './FileTreeWidget'

export interface FileTreePluginOptions {
  viewId?: string
  title?: string
  icon?: string
  groupId?: string
  container?: 'left' | 'right' | 'center'
  tabOf?: string
  belowOf?: string
  closable?: boolean
  initialSize?: number
}

export function createFileTreePlugin(options: FileTreePluginOptions = {}): VaultPlugin {
  const viewId = options.viewId ?? 'filetree'
  const title = options.title ?? 'Explorer'
  const icon = options.icon ?? 'folder'
  const container = options.container ?? 'left'

  return {
    manifest: {
      id: 'plugin-filetree',
      name: 'File Explorer',
      version: '0.0.1',
      description: 'Sidebar file tree view',
      permissions: ['vault:read', 'ui:editor'],
    },

    async onload(api: PluginAPI) {
      api.views.register({
        id: viewId,
        title,
        icon,
        groupId: options.groupId,
        container,
        tabOf: options.tabOf,
        belowOf: options.belowOf,
        closable: options.closable,
        initialSize: options.initialSize,
        createView(ctx) {
          return new FileTreeWidget(ctx)
        },
      })
    },

    async onunload() {},
  }
}

const plugin = createFileTreePlugin()

export default plugin
export { FileTreeWidget } from './FileTreeWidget'
export { FileTree } from './FileTreeWidget'
