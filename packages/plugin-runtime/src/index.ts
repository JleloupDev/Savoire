// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
export { PluginLoader } from './PluginLoader'
export { PluginSandbox } from './PluginSandbox'
export { PermissionFilteredAPI } from './PermissionFilteredAPI'
export type { PluginEntry } from './PluginLoader'
export {
  BlockRegistryImpl,
  HookRegistryImpl,
  IndexRegistryImpl,
  CommandRegistryImpl,
  FileTypeRegistryImpl,
  VaultAPIStub,
  WorkspaceAPIStub,
  SlashRegistryImpl,
  TriggerRegistryImpl,
  ToolbarCommandRegistryImpl,
  EditorPositionAPIStub,
  PluginAPIImpl,
} from './PluginRegistries'
