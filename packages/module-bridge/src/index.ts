// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
export type {
  VaultRequest,
  ModuleReady,
  ModuleResize,
  ModuleToHostMsg,
  VaultResponse,
  VaultPreload,
  VaultSnapshot,
  HostToModuleMsg,
} from './protocol'

export { IframeVaultAPI } from './IframeVaultAPI'
export { VaultHostBridge } from './VaultHostBridge'
