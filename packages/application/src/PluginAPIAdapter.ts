// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import type {
  BlockRegistry,
  CommandRegistry,
  DocMetadata,
  EditorPositionAPI,
  FileTreeEntry,
  FileTypeRegistry,
  HookRegistry,
  IPluginAPI,
  IPluginBlocksAPI,
  IPluginCommandsAPI,
  IPluginEditorAPI,
  IPluginHooksAPI,
  IPluginSlashAPI,
  IPluginToolbarAPI,
  IPluginTriggersAPI,
  IPluginVaultAPI,
  IPluginViewsAPI,
  IPluginWorkspaceAPI,
  SlashRegistry,
  ToolbarCommandRegistry,
  TriggerRegistry,
  VaultAPI,
  ViewRegistry,
  WorkspaceAPI,
} from '@savoire/plugin-api'
import type { MetadataIndexContributor } from './MetadataIndexContributor'

export class PluginVaultAPIAdapter implements IPluginVaultAPI {
  constructor(
    private readonly inner: VaultAPI,
    private readonly metadata?: MetadataIndexContributor,
  ) {}

  read(documentId: string): Promise<string> { return this.inner.read(documentId) }
  readDocumentByPath(path: string): Promise<string> { return this.inner.readDocumentByPath(path) }
  write(documentId: string, content: string): Promise<void> { return this.inner.write(documentId, content) }
  list(dir?: string): Promise<string[]> { return this.inner.list(dir) }
  exists(documentId: string): Promise<boolean> { return this.inner.exists(documentId) }
  resolveDocumentId(path: string): string | undefined { return this.inner.resolveDocumentId(path) }
  createFile(path: string): Promise<void> { return this.inner.createFile?.(path) ?? Promise.resolve() }
  createFolder(path: string): Promise<void> { return this.inner.createFolder?.(path) ?? Promise.resolve() }
  renameFile(documentId: string, newPath: string): Promise<void> {
    return this.inner.renameFile?.(documentId, newPath) ?? Promise.resolve()
  }
  deleteFile(documentId: string): Promise<void> { return this.inner.deleteFile?.(documentId) ?? Promise.resolve() }
  deleteFolder(path: string): Promise<void> { return this.inner.deleteFolder?.(path) ?? Promise.resolve() }
  getVaultId(): string { return this.inner.getVaultId?.() ?? '' }
  getToken(): string { return this.inner.getToken?.() ?? '' }
  getFileTree(): FileTreeEntry[] {
    return this.metadata?.getAllMetadata().map(m => ({ docId: m.docId, path: m.path, crdtVersion: m.crdtVersion })) ?? []
  }
  getMetadata(docId: string): DocMetadata | null {
    return this.metadata?.getMetadata(docId) ?? null
  }
}

export class PluginWorkspaceAPIAdapter implements IPluginWorkspaceAPI {
  constructor(private readonly inner: WorkspaceAPI) {}

  openFile(path: string): Promise<void> { return this.inner.openFile(path) }
  openPanel(panelId: string): void { this.inner.openPanel(panelId) }
  closePanel(panelId: string): void { this.inner.closePanel(panelId) }
  getActiveDocument() { return this.inner.getActiveDocument() }
  subscribeVaultChange(cb: () => void): () => void { return this.inner.subscribeVaultChange?.(cb) ?? (() => {}) }
  notifyVaultChange(): void { this.inner.notifyVaultChange?.() }
  subscribeOpenFile(cb: (path: string) => void): () => void {
    return this.inner.subscribeOpenFile?.(cb) ?? (() => {})
  }
  subscribeDocumentIndexed(cb: (docId: string, path: string) => void): () => void {
    return this.inner.subscribeDocumentIndexed?.(cb) ?? (() => {})
  }
}

export class PluginCommandsAPIAdapter implements IPluginCommandsAPI {
  constructor(private readonly inner: CommandRegistry) {}
  register(command: Parameters<CommandRegistry['register']>[0]): void { this.inner.register(command) }
  unregister(id: string): void { this.inner.unregister(id) }
}

export class PluginViewsAPIAdapter implements IPluginViewsAPI {
  constructor(private readonly inner: ViewRegistry) {}
  register(spec: Parameters<ViewRegistry['register']>[0]): void { this.inner.register(spec) }
  unregister(id: string): void { this.inner.unregister(id) }
  getAll() { return this.inner.getAll() }
  registerGroup(group: Parameters<ViewRegistry['registerGroup']>[0]): void { this.inner.registerGroup(group) }
  unregisterGroup(id: string): void { this.inner.unregisterGroup(id) }
  getGroups() { return this.inner.getGroups() }
}

export class PluginBlocksAPIAdapter implements IPluginBlocksAPI {
  constructor(private readonly inner: BlockRegistry) {}
  register(spec: Parameters<BlockRegistry['register']>[0]): void { this.inner.register(spec) }
  unregister(type: string): void { this.inner.unregister(type) }
  detectBlock(text: string) { return this.inner.detectBlock(text) }
  getAll() { return this.inner.getAll() }
}

export class PluginSlashAPIAdapter implements IPluginSlashAPI {
  constructor(private readonly inner: SlashRegistry) {}
  register(item: Parameters<SlashRegistry['register']>[0]): void { this.inner.register(item) }
  unregister(id: string): void { this.inner.unregister(id) }
  getAll() { return this.inner.getAll() }
}

export class PluginTriggersAPIAdapter implements IPluginTriggersAPI {
  constructor(private readonly inner: TriggerRegistry) {}
  register(trigger: Parameters<TriggerRegistry['register']>[0]): void { this.inner.register(trigger) }
  unregister(id: string): void { this.inner.unregister(id) }
  getAll() { return this.inner.getAll() }
  findConflict(character: string) { return this.inner.findConflict(character) }
}

export class PluginEditorAPIAdapter implements IPluginEditorAPI {
  constructor(private readonly inner: EditorPositionAPI) {}
  getCursorCoords() { return this.inner.getCursorCoords() }
  getSelectionCoords() { return this.inner.getSelectionCoords() }
  getSelectionText() { return this.inner.getSelectionText() }
}

export class PluginToolbarAPIAdapter implements IPluginToolbarAPI {
  constructor(private readonly inner: ToolbarCommandRegistry) {}
  register(cmd: Parameters<ToolbarCommandRegistry['register']>[0]): void { this.inner.register(cmd) }
  unregister(id: string): void { this.inner.unregister(id) }
  getAll() { return this.inner.getAll() }
  getByGroup(group: string) { return this.inner.getByGroup(group) }
}

export class PluginHooksAPIAdapter implements IPluginHooksAPI {
  constructor(private readonly inner: HookRegistry) {}
  beforeParse(hook: Parameters<HookRegistry['beforeParse']>[0]): void { this.inner.beforeParse(hook) }
  afterParse(hook: Parameters<HookRegistry['afterParse']>[0]): void { this.inner.afterParse(hook) }
  beforeRender(hook: Parameters<HookRegistry['beforeRender']>[0]): void { this.inner.beforeRender(hook) }
  afterRender(hook: Parameters<HookRegistry['afterRender']>[0]): void { this.inner.afterRender(hook) }
  onDocumentOpen(hook: Parameters<HookRegistry['onDocumentOpen']>[0]): void { this.inner.onDocumentOpen(hook) }
  onDocumentSave(hook: Parameters<HookRegistry['onDocumentSave']>[0]): void { this.inner.onDocumentSave(hook) }
  onSelectionChange(hook: Parameters<HookRegistry['onSelectionChange']>[0]): void { this.inner.onSelectionChange(hook) }
  runBeforeParse(source: string): Promise<string> { return this.inner.runBeforeParse(source) }
  runBeforeParseSync(source: string): string { return this.inner.runBeforeParseSync(source) }
  runAfterRender(html: string): Promise<string> { return this.inner.runAfterRender(html) }
  onDocumentStabilized(hook: Parameters<HookRegistry['onDocumentStabilized']>[0]): void { this.inner.onDocumentStabilized(hook) }
  runDocumentOpen(path: string): void { this.inner.runDocumentOpen(path) }
  runDocumentSave(content: string): void { this.inner.runDocumentSave(content) }
  runDocumentStabilized(docId: string, path: string, content: string, crdtVersion?: import('@savoire/domain-index').CrdtVersion): void { this.inner.runDocumentStabilized(docId, path, content, crdtVersion) }
}

export interface PluginAPIAdapterDeps {
  vault: VaultAPI
  workspace: WorkspaceAPI
  commands: CommandRegistry
  views: ViewRegistry
  blocks: BlockRegistry
  hooks: HookRegistry
  files: FileTypeRegistry
  slash: SlashRegistry
  triggers: TriggerRegistry
  editor?: EditorPositionAPI
  toolbar?: ToolbarCommandRegistry
  metadata?: MetadataIndexContributor
}

export class PluginAPIAdapter implements IPluginAPI {
  readonly vault: IPluginVaultAPI
  readonly workspace: IPluginWorkspaceAPI
  readonly commands: IPluginCommandsAPI
  readonly views: IPluginViewsAPI
  readonly blocks: IPluginBlocksAPI
  readonly hooks: IPluginHooksAPI
  readonly files: FileTypeRegistry
  readonly slash: IPluginSlashAPI
  readonly triggers: IPluginTriggersAPI
  readonly editor: IPluginEditorAPI
  readonly toolbar: IPluginToolbarAPI

  constructor(deps: PluginAPIAdapterDeps) {
    this.vault     = new PluginVaultAPIAdapter(deps.vault, deps.metadata)
    this.workspace = new PluginWorkspaceAPIAdapter(deps.workspace)
    this.commands  = new PluginCommandsAPIAdapter(deps.commands)
    this.views     = new PluginViewsAPIAdapter(deps.views)
    this.blocks    = new PluginBlocksAPIAdapter(deps.blocks)
    this.hooks     = new PluginHooksAPIAdapter(deps.hooks)
    this.files     = deps.files
    this.slash     = new PluginSlashAPIAdapter(deps.slash)
    this.triggers  = new PluginTriggersAPIAdapter(deps.triggers)
    // editor and toolbar default to stubs when not provided (e.g. in tests)
    this.editor    = new PluginEditorAPIAdapter(deps.editor ?? {
      getCursorCoords: () => null,
      getSelectionCoords: () => null,
      getSelectionText: () => '',
    })
    this.toolbar   = new PluginToolbarAPIAdapter(deps.toolbar ?? {
      register: () => {},
      unregister: () => {},
      getAll: () => [],
      getByGroup: () => [],
    })
  }
}
