// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
export { PluginLoader } from './PluginLoader'
export { PluginActivation } from './PluginActivation'
export { PluginSandbox, wrapCommonJs, isCommonJsPlugin } from './PluginSandbox'
export { PermissionFilteredAPI } from './PermissionFilteredAPI'
export { InMemorySharedText, applyTextDelta } from './InMemorySharedText'
export { InMemoryQueryEngine, QueryError, foldText } from './InMemoryQueryEngine'
export type { IndexedDoc } from './InMemoryQueryEngine'
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
export { SharedLibraryRegistry, requiredLibraries } from './SharedLibraryRegistry'
export { ExtractorRegistryImpl } from './ExtractorRegistry'
export { FramedPlugin, buildPluginSrcdoc, framedPluginCsp, checkExtracted, idAfterCreate, setPluginFrameUrl, MAX_FRAME_WRITES_PER_MINUTE } from './FramedPlugin'
export type { FramedPluginOptions } from './FramedPlugin'
export { verifyStorePackage, sha256Hex, storeKeyId, StorePackageError } from './StorePackage'
export type { StorePackage, StoreItemKind } from './StorePackage'
