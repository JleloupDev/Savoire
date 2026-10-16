// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
export { PluginLoader } from './PluginLoader'
export { PluginActivation } from './PluginActivation'
export { PluginSandbox } from './PluginSandbox'
export { PermissionFilteredAPI } from './PermissionFilteredAPI'
export { InMemorySharedText, applyTextDelta } from './InMemorySharedText'
export { InMemorySharedTree } from './InMemorySharedTree'
export { HotkeyManager, detectPlatform, eventKey, formatHotkey, hotkeyFromEvent, sanitizeCustomHotkeys } from './HotkeyManager'
export type { HotkeyPlatform, HotkeyCommandSource } from './HotkeyManager'
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
  AgentRegistryImpl,
} from './PluginRegistries'
