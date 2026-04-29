// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// Plugin API registry implementations.
// Kept separate from types (plugin-api) so that package has no runtime code.

import type {
  BlockRegistry,
  BlockSpec,
  BlockTrigger,
  CommandRegistry,
  EditorPositionAPI,
  FileTypeRegistry,
  FileTypeSpec,
  HookRegistry,
  IEditorHostAPI,
  IIndexRegistry,
  IndexContributor,
  InputTrigger,
  PluginAPI,
  PluginCommand,
  SlashCommandItem,
  SlashRegistry,
  SyncAPI,
  ToolbarCommand,
  ToolbarCommandRegistry,
  TriggerRegistry,
  WorkspaceAPI,
  VaultAPI,
  ViewGroup,
  ViewRegistry,
  ViewSpec,
} from '@savoire/plugin-api'

// ─── TriggerRegistryImpl ──────────────────────────────────────────────────

export class TriggerRegistryImpl implements TriggerRegistry {
  private readonly triggers = new Map<string, InputTrigger>()

  register(trigger: InputTrigger): void {
    const conflict = this.findConflict(trigger.character)
    if (conflict && conflict.id !== trigger.id) {
      console.warn(
        `[TriggerRegistry] Conflict: "${trigger.character}" is already claimed by "${conflict.id}". ` +
        `Plugin "${trigger.id}" may not work as expected.`
      )
    }
    this.triggers.set(trigger.id, trigger)
  }

  unregister(id: string): void {
    this.triggers.delete(id)
  }

  getAll(): InputTrigger[] {
    return [...this.triggers.values()]
  }

  findConflict(character: string): InputTrigger | undefined {
    for (const t of this.triggers.values()) {
      if (t.character === character) return t
    }
    return undefined
  }
}

// ─── BlockRegistryImpl ────────────────────────────────────────────────────

interface BlockEntry { spec: BlockSpec; pluginId?: string }

export class BlockRegistryImpl implements BlockRegistry {
  // see ADR-012
  private readonly specEntries = new Map<string, BlockEntry>()

  // Set by PluginLoader before calling plugin.onload() when tag=true.
  // Any spec registered while this is set gets stamped with this plugin id.
  _currentPluginId?: string

  constructor(private readonly slashRegistry?: SlashRegistry) {}

  register(spec: BlockSpec): void {
    const pluginId = this._currentPluginId
    this.specEntries.set(spec.type, { spec, pluginId })
    console.debug(`[BlockRegistry] registered: ${spec.type}${pluginId ? ` (${pluginId})` : ''}`)
    if (spec.trigger && this.slashRegistry) {
      const triggers: BlockTrigger[] = Array.isArray(spec.trigger) ? spec.trigger : [spec.trigger]
      for (const t of triggers) {
        this.slashRegistry.register({
          id: t.id, label: t.label, description: t.description,
          icon: t.icon, category: t.category, insert: t.insert,
        })
      }
    }
  }

  unregister(type: string): void {
    const entry = this.specEntries.get(type)
    if (entry?.spec.trigger && this.slashRegistry) {
      const triggers: BlockTrigger[] = Array.isArray(entry.spec.trigger) ? entry.spec.trigger : [entry.spec.trigger]
      for (const t of triggers) this.slashRegistry.unregister(t.id)
    }
    this.specEntries.delete(type)
  }

  detectBlock(text: string): { type: string; spec: BlockSpec } | null {
    return this.detectActive(text, null)
  }

  // see ADR-012
  detectActive(text: string, ids: Set<string> | null): { type: string; spec: BlockSpec } | null {
    for (const [type, { spec, pluginId }] of this.specEntries) {
      if (!spec.detect) continue
      if (ids !== null && !ids.has(pluginId ?? '')) continue
      const matched = spec.detect instanceof RegExp ? spec.detect.test(text) : spec.detect(text)
      if (matched) return { type, spec }
    }
    return null
  }

  getAll(): BlockSpec[] {
    return [...this.specEntries.values()].map(e => e.spec)
  }

  getActive(ids: Set<string> | null): BlockSpec[] {
    if (ids === null) return this.getAll()
    return [...this.specEntries.values()]
      .filter(e => ids.has(e.pluginId ?? ''))
      .map(e => e.spec)
  }
}

// ─── HookRegistryImpl ─────────────────────────────────────────────────────

type StrHook = (s: string) => string | Promise<string>
type UnknownHook = (v: unknown) => unknown | Promise<unknown>
type VoidHook<T> = (v: T) => void
type StabilizedHook = (docId: string, path: string, content: string, crdtVersion?: import('@savoire/domain-index').CrdtVersion) => void

export class HookRegistryImpl implements HookRegistry {
  private beforeParseHooks: StrHook[] = []
  private afterParseHooks: UnknownHook[] = []
  private beforeRenderHooks: UnknownHook[] = []
  private afterRenderHooks: StrHook[] = []
  private documentOpenHooks: VoidHook<string>[] = []
  private documentSaveHooks: VoidHook<string>[] = []
  private selectionChangeHooks: VoidHook<unknown>[] = []
  private documentStabilizedHooks: StabilizedHook[] = []

  beforeParse(hook: StrHook): void { this.beforeParseHooks.push(hook) }
  afterParse(hook: UnknownHook): void { this.afterParseHooks.push(hook) }
  beforeRender(hook: UnknownHook): void { this.beforeRenderHooks.push(hook) }
  afterRender(hook: StrHook): void { this.afterRenderHooks.push(hook) }
  onDocumentOpen(hook: VoidHook<string>): void { this.documentOpenHooks.push(hook) }
  onDocumentSave(hook: VoidHook<string>): void { this.documentSaveHooks.push(hook) }
  onSelectionChange(hook: VoidHook<unknown>): void { this.selectionChangeHooks.push(hook) }
  onDocumentStabilized(hook: StabilizedHook): void { this.documentStabilizedHooks.push(hook) }

  async runBeforeParse(source: string): Promise<string> {
    let s = source
    for (const h of this.beforeParseHooks) s = await h(s)
    return s
  }

  runBeforeParseSync(source: string): string {
    let s = source
    for (const h of this.beforeParseHooks) {
      const result = h(s)
      // Skip async hooks — only sync string returns are applied in the CM6 StateField
      if (typeof result === 'string') s = result
    }
    return s
  }

  async runAfterRender(html: string): Promise<string> {
    let h = html
    for (const hook of this.afterRenderHooks) h = await hook(h)
    return h
  }

  runDocumentOpen(path: string): void {
    this.documentOpenHooks.forEach(h => h(path))
  }

  runDocumentSave(content: string): void {
    this.documentSaveHooks.forEach(h => h(content))
  }

  runDocumentStabilized(docId: string, path: string, content: string, crdtVersion?: import('@savoire/domain-index').CrdtVersion): void {
    this.documentStabilizedHooks.forEach(h => h(docId, path, content, crdtVersion))
  }
}

// ─── IndexRegistryImpl ────────────────────────────────────────────────────

export class IndexRegistryImpl implements IIndexRegistry {
  private readonly factories = new Map<string, () => IndexContributor>()
  private current = new Map<string, IndexContributor>()

  registerFactory(factory: () => IndexContributor): void {
    const instance = factory()
    this.factories.set(instance.namespace, factory)
    this.current.set(instance.namespace, instance)
    console.debug(`[IndexRegistry] registered factory: ${instance.namespace}`)
  }

/** Recreates all contributor instances from factories. Call on vault switch. */
  rebuild(): void {
    this.current = new Map(
      [...this.factories.entries()].map(([ns, factory]) => [ns, factory()])
    )
    console.debug(`[IndexRegistry] rebuilt ${this.current.size} contributors`)
  }

  getAll(): IndexContributor[] {
    return [...this.current.values()]
  }

  get(namespace: string): IndexContributor | undefined {
    return this.current.get(namespace)
  }
}

// ─── CommandRegistryImpl ──────────────────────────────────────────────────

export class CommandRegistryImpl implements CommandRegistry {
  private readonly commands = new Map<string, PluginCommand>()

  register(command: PluginCommand): void {
    this.commands.set(command.id, command)
  }

  unregister(id: string): void {
    this.commands.delete(id)
  }

  execute(id: string, context: { editorView: unknown }): void {
    const cmd = this.commands.get(id)
    if (!cmd) { console.warn(`[CommandRegistry] unknown command: ${id}`); return }
    cmd.run(context)
  }

  getAll(): PluginCommand[] {
    return [...this.commands.values()]
  }
}

// ─── FileTypeRegistryImpl ─────────────────────────────────────────────────

export class FileTypeRegistryImpl implements FileTypeRegistry {
  private readonly specs = new Map<string, FileTypeSpec>()

  register(spec: FileTypeSpec): void { this.specs.set(spec.extension, spec) }
  unregister(ext: string): void { this.specs.delete(ext) }
  resolve(ext: string): FileTypeSpec | undefined { return this.specs.get(ext) }
  getAll(): FileTypeSpec[] { return [...this.specs.values()].sort((a, b) => a.extension.localeCompare(b.extension)) }
}

// ─── VaultAPIStub ─────────────────────────────────────────────────────────
// No-op implementation for editor-dev (offline). Replace with a real
// implementation when the server is available.

export class VaultAPIStub implements VaultAPI {
  async read(_documentId: string): Promise<string> { return '' }
  async readDocumentByPath(_path: string): Promise<string> { return '' }
  async write(_documentId: string, _content: string): Promise<void> {}
  async list(_dir?: string): Promise<string[]> { return [] }
  async exists(_documentId: string): Promise<boolean> { return false }
  resolveDocumentId(_path: string): string | undefined { return undefined }
}

export class WorkspaceAPIStub implements WorkspaceAPI {
  async openFile(_path: string): Promise<void> {}
  openPanel(_panelId: string): void {}
  closePanel(_panelId: string): void {}
  getActiveDocument() { return undefined }
}

// ─── SlashRegistryImpl ────────────────────────────────────────────────────

export class SlashRegistryImpl implements SlashRegistry {
  private readonly items = new Map<string, SlashCommandItem>()

  register(item: SlashCommandItem): void {
    this.items.set(item.id, item)
  }

  unregister(id: string): void {
    this.items.delete(id)
  }

  getAll(): SlashCommandItem[] {
    return [...this.items.values()]
  }
}

// ─── ViewRegistryStub ─────────────────────────────────────────────────────
// No-op for contexts where no workspace is available (e.g. editor-only mode).

export class ViewRegistryStub implements ViewRegistry {
  register(_spec: ViewSpec): void {}
  unregister(_id: string): void {}
  getAll(): ViewSpec[] { return [] }
  registerGroup(_group: ViewGroup): void {}
  unregisterGroup(_id: string): void {}
  getGroups(): ViewGroup[] { return [] }
}

// ─── ToolbarCommandRegistryImpl ───────────────────────────────────────────

export class ToolbarCommandRegistryImpl implements ToolbarCommandRegistry {
  private cmds = new Map<string, ToolbarCommand>()
  register(cmd: ToolbarCommand): void { this.cmds.set(cmd.id, cmd) }
  unregister(id: string): void { this.cmds.delete(id) }
  getAll(): ToolbarCommand[] { return Array.from(this.cmds.values()) }
  getByGroup(group: string): ToolbarCommand[] { return this.getAll().filter(c => c.group === group) }
}

// ─── EditorPositionAPIStub ────────────────────────────────────────────────
// No-op stub used before EditorCore wires the real implementation.

export class EditorPositionAPIStub implements EditorPositionAPI {
  getCursorCoords(): { x: number; y: number } | null { return null }
  getSelectionCoords(): { x: number; y: number } | null { return null }
  getSelectionText(): string { return '' }
}

// ─── PluginAPIImpl ────────────────────────────────────────────────────────

export class PluginAPIImpl implements PluginAPI, IEditorHostAPI {
  public editor: EditorPositionAPI

  constructor(
    public readonly blocks: BlockRegistryImpl,
    public readonly hooks: HookRegistryImpl,
    public readonly commands: CommandRegistryImpl,
    public readonly files: FileTypeRegistryImpl,
    public readonly vault: VaultAPI,
    public readonly workspace: WorkspaceAPI,
    public readonly views: ViewRegistry,
    public readonly slash: SlashRegistryImpl,
    public readonly triggers: TriggerRegistryImpl,
    public readonly toolbar: ToolbarCommandRegistryImpl,
    editor?: EditorPositionAPI,
    public readonly sync?: SyncAPI,
    public readonly index?: IndexRegistryImpl,
  ) {
    this.editor = editor ?? new EditorPositionAPIStub()
  }

  /** Called by EditorCore after the view is created to wire in the real position API. */
  setEditorPositionAPI(api: EditorPositionAPI): void {
    this.editor = api
  }

  static create(vault?: VaultAPI, sync?: SyncAPI): PluginAPIImpl {
    const slash    = new SlashRegistryImpl()
    const triggers = new TriggerRegistryImpl()
    return new PluginAPIImpl(
      new BlockRegistryImpl(slash),
      new HookRegistryImpl(),
      new CommandRegistryImpl(),
      new FileTypeRegistryImpl(),
      vault ?? new VaultAPIStub(),
      new WorkspaceAPIStub(),
      new ViewRegistryStub(),
      slash,
      triggers,
      new ToolbarCommandRegistryImpl(),
      undefined,
      sync,
      new IndexRegistryImpl(),
    )
  }
}
