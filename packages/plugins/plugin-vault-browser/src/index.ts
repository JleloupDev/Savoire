// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import type { PluginAPI, VaultPlugin } from '@savoire/plugin-api'
import { VaultBrowserWidget, type VaultBrowserRefs, type VaultSummaryLike } from './VaultBrowserWidget'

export interface VaultBrowserPluginOptions<TVault extends VaultSummaryLike = VaultSummaryLike> {
  refs: VaultBrowserRefs<TVault>
  viewId?: string
  title?: string
  groupId?: string
  container?: 'left' | 'right' | 'center' | 'bottom'
  initialSize?: number
  tabOf?: string
  belowOf?: string
  closable?: boolean
  ribbon?: boolean
  icon?: string
}

export function createVaultBrowserPlugin<TVault extends VaultSummaryLike = VaultSummaryLike>(
  options: VaultBrowserPluginOptions<TVault>,
): VaultPlugin {
  const viewId = options.viewId ?? 'vault-browser'
  const title = options.title ?? 'Vaults'
  const container = options.container ?? 'left'
  const initialSize = options.initialSize ?? 260

  return {
    manifest: {
      id: 'plugin-vault-browser',
      name: 'Vault Browser',
      version: '0.0.1',
      description: 'Sidebar vault browser view',
      permissions: ['ui:editor'],
    },
    async onload(api: PluginAPI) {
      api.views.register({
        id: viewId,
        title,
        groupId: options.groupId,
        container,
        initialSize,
        tabOf: options.tabOf,
        belowOf: options.belowOf,
        closable: options.closable,
        ribbon: options.ribbon,
        icon: options.icon,
        createView(ctx) {
          return new VaultBrowserWidget(ctx.workspace, options.refs)
        },
      })
    },
    async onunload() {},
  }
}

export { VaultBrowserWidget } from './VaultBrowserWidget'
export type { VaultBrowserRefs, VaultSummaryLike, SharedNoteLike, VaultBrowserWorkspaceLike } from './VaultBrowserWidget'
