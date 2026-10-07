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
  AnyIndexContributor,
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
import type { PluginActivation } from './PluginActivation'

// Chaque registre retient quel plugin a enregistre quoi, et filtre a la
// lecture ce qui appartient a un plugin desactive. Voir PluginActivation.
// Sans activation branchee (tests, editeur seul), tout est actif.

interface Owned<T> { item: T; pluginId?: string }

function ownerOf(activation?: PluginActivation): string | undefined {
  return activation?.currentPluginId
}

function enabled(activation: PluginActivation | undefined, pluginId: string | undefined): boolean {
  return !activation || activation.isEnabled(pluginId)
}

// ─── TriggerRegistryImpl ──────────────────────────────────────────────────

export class TriggerRegistryImpl implements TriggerRegistry {
  private readonly triggers = new Map<string, Owned<InputTrigger>>()
  activation?: PluginActivation

  register(trigger: InputTrigger): void {
    const conflict = this.findConflict(trigger.character)
    if (conflict && conflict.id !== trigger.id) {
      console.warn(
        `[TriggerRegistry] Conflict: "${trigger.character}" is already claimed by "${conflict.id}". ` +
        `Plugin "${trigger.id}" may not work as expected.`
      )
    }
    this.triggers.set(trigger.id, { item: trigger, pluginId: ownerOf(this.activation) })
  }

  unregister(id: string): void {
    this.triggers.delete(id)
  }

  getAll(): InputTrigger[] {
    return [...this.triggers.values()].filter(e => enabled(this.activation, e.pluginId)).map(e => e.item)
  }

  findConflict(character: string): InputTrigger | undefined {
    for (const t of this.getAll()) {
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
  activation?: PluginActivation

  constructor(private readonly slashRegistry?: SlashRegistry) {}

  register(spec: BlockSpec): void {
    const pluginId = this._currentPluginId ?? ownerOf(this.activation)
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
      if (!enabled(this.activation, pluginId)) continue
      if (ids !== null && !ids.has(pluginId ?? '')) continue
      const matched = spec.detect instanceof RegExp ? spec.detect.test(text) : spec.detect(text)
      if (matched) return { type, spec }
    }
    return null
  }

  getAll(): BlockSpec[] {
    return [...this.specEntries.values()]
      .filter(e => enabled(this.activation, e.pluginId))
      .map(e => e.spec)
  }

  getActive(ids: Set<string> | null): BlockSpec[] {
    if (ids === null) return this.getAll()
    return [...this.specEntries.values()]
      .filter(e => enabled(this.activation, e.pluginId) && ids.has(e.pluginId ?? ''))
      .map(e => e.spec)
  }
}

// ─── HookRegistryImpl ─────────────────────────────────────────────────────

type StrHook = (s: string) => string | Promise<string>
type UnknownHook = (v: unknown) => unknown | Promise<unknown>
type VoidHook<T> = (v: T) => void
type StabilizedHook = (docId: string, path: string, content: string, crdtVersion?: import('@savoire/domain-index').CrdtVersion) => void

export class HookRegistryImpl implements HookRegistry {
  private beforeParseHooks: Owned<StrHook>[] = []
  private afterParseHooks: Owned<UnknownHook>[] = []
  private beforeRenderHooks: Owned<UnknownHook>[] = []
  private afterRenderHooks: Owned<StrHook>[] = []
  private documentOpenHooks: Owned<VoidHook<string>>[] = []
  private documentSaveHooks: Owned<VoidHook<string>>[] = []
  private selectionChangeHooks: Owned<VoidHook<unknown>>[] = []
  private documentStabilizedHooks: Owned<StabilizedHook>[] = []
  activation?: PluginActivation

  private own<T>(item: T): Owned<T> {
    return { item, pluginId: ownerOf(this.activation) }
  }

  /** Hooks des plugins actifs, dans l'ordre d'enregistrement. */
  private live<T>(list: Owned<T>[]): T[] {
    return list.filter(e => enabled(this.activation, e.pluginId)).map(e => e.item)
  }

  beforeParse(hook: StrHook): void { this.beforeParseHooks.push(this.own(hook)) }
  afterParse(hook: UnknownHook): void { this.afterParseHooks.push(this.own(hook)) }
  beforeRender(hook: UnknownHook): void { this.beforeRenderHooks.push(this.own(hook)) }
  afterRender(hook: StrHook): void { this.afterRenderHooks.push(this.own(hook)) }
  onDocumentOpen(hook: VoidHook<string>): void { this.documentOpenHooks.push(this.own(hook)) }
  onDocumentSave(hook: VoidHook<string>): void { this.documentSaveHooks.push(this.own(hook)) }
  onSelectionChange(hook: VoidHook<unknown>): void { this.selectionChangeHooks.push(this.own(hook)) }
  onDocumentStabilized(hook: StabilizedHook): void { this.documentStabilizedHooks.push(this.own(hook)) }

  async runBeforeParse(source: string): Promise<string> {
    let s = source
    for (const h of this.live(this.beforeParseHooks)) s = await h(s)
    return s
  }

  runBeforeParseSync(source: string): string {
    let s = source
    for (const h of this.live(this.beforeParseHooks)) {
      const result = h(s)
      // Skip async hooks — only sync string returns are applied in the CM6 StateField
      if (typeof result === 'string') s = result
    }
    return s
  }

  async runAfterRender(html: string): Promise<string> {
    let h = html
    for (const hook of this.live(this.afterRenderHooks)) h = await hook(h)
    return h
  }

  runDocumentOpen(path: string): void {
    this.live(this.documentOpenHooks).forEach(h => h(path))
  }

  runDocumentSave(content: string): void {
    this.live(this.documentSaveHooks).forEach(h => h(content))
  }

  runDocumentStabilized(docId: string, path: string, content: string, crdtVersion?: import('@savoire/domain-index').CrdtVersion): void {
    this.live(this.documentStabilizedHooks).forEach(h => h(docId, path, content, crdtVersion))
  }
}

// ─── IndexRegistryImpl ────────────────────────────────────────────────────

export class IndexRegistryImpl implements IIndexRegistry {
  private readonly factories = new Map<string, () => AnyIndexContributor>()
  private readonly owners = new Map<string, string | undefined>()
  private current = new Map<string, AnyIndexContributor>()
  activation?: PluginActivation

  registerFactory(factory: () => AnyIndexContributor): void {
    const instance = factory()
    this.factories.set(instance.namespace, factory)
    this.owners.set(instance.namespace, ownerOf(this.activation))
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

  /** Contributeurs des plugins actifs : ceux qui calculent de nouvelles entrees. */
  getAll(): AnyIndexContributor[] {
    return [...this.current.values()].filter(c => enabled(this.activation, this.owners.get(c.namespace)))
  }

  /**
   * Tous les contributeurs, actifs ou non. Les canaux partages restent ouverts
   * pour un plugin desactive : son index n'est pas detruit, et le reactiver
   * le retrouve tel quel.
   */
  getAllRegistered(): AnyIndexContributor[] {
    return [...this.current.values()]
  }

  get(namespace: string): AnyIndexContributor | undefined {
    return this.current.get(namespace)
  }
}

// ─── CommandRegistryImpl ──────────────────────────────────────────────────

export class CommandRegistryImpl implements CommandRegistry {
  private readonly commands = new Map<string, Owned<PluginCommand>>()
  activation?: PluginActivation

  register(command: PluginCommand): void {
    this.commands.set(command.id, { item: command, pluginId: ownerOf(this.activation) })
  }

  unregister(id: string): void {
    this.commands.delete(id)
  }

  execute(id: string, context: { editorView: unknown }): void {
    const entry = this.commands.get(id)
    if (!entry || !enabled(this.activation, entry.pluginId)) { console.warn(`[CommandRegistry] unknown command: ${id}`); return }
    entry.item.run(context)
  }

  getAll(): PluginCommand[] {
    return [...this.commands.values()].filter(e => enabled(this.activation, e.pluginId)).map(e => e.item)
  }
}

// ─── FileTypeRegistryImpl ─────────────────────────────────────────────────

export class FileTypeRegistryImpl implements FileTypeRegistry {
  private readonly specs = new Map<string, Owned<FileTypeSpec>>()
  activation?: PluginActivation

  register(spec: FileTypeSpec): void { this.specs.set(spec.extension, { item: spec, pluginId: ownerOf(this.activation) }) }
  unregister(ext: string): void { this.specs.delete(ext) }

  /** Type actif pour cette extension. Undefined si aucun plugin actif ne la gere. */
  resolve(ext: string): FileTypeSpec | undefined {
    const entry = this.specs.get(ext)
    return entry && enabled(this.activation, entry.pluginId) ? entry.item : undefined
  }

  /**
   * Type declare pour cette extension, que son plugin soit actif ou non. Sert
   * a ce qui ne doit pas dependre de l'activation, comme la nature d'un
   * document (CRDT ou snapshot) : couper un plugin ne change pas ses donnees.
   */
  resolveRegistered(ext: string): FileTypeSpec | undefined {
    return this.specs.get(ext)?.item
  }

  /** Plugin qui gere cette extension, actif ou non : pour proposer de le reactiver. */
  ownerOf(ext: string): string | undefined {
    return this.specs.get(ext)?.pluginId
  }

  getAll(): FileTypeSpec[] {
    return [...this.specs.values()]
      .filter(e => enabled(this.activation, e.pluginId))
      .map(e => e.item)
      .sort((a, b) => a.extension.localeCompare(b.extension))
  }
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
  private readonly items = new Map<string, Owned<SlashCommandItem>>()
  activation?: PluginActivation

  register(item: SlashCommandItem): void {
    this.items.set(item.id, { item, pluginId: ownerOf(this.activation) })
  }

  unregister(id: string): void {
    this.items.delete(id)
  }

  getAll(): SlashCommandItem[] {
    return [...this.items.values()].filter(e => enabled(this.activation, e.pluginId)).map(e => e.item)
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
  private cmds = new Map<string, Owned<ToolbarCommand>>()
  activation?: PluginActivation
  register(cmd: ToolbarCommand): void { this.cmds.set(cmd.id, { item: cmd, pluginId: ownerOf(this.activation) }) }
  unregister(id: string): void { this.cmds.delete(id) }
  getAll(): ToolbarCommand[] {
    return Array.from(this.cmds.values()).filter(e => enabled(this.activation, e.pluginId)).map(e => e.item)
  }
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

  /**
   * Branche l'activation sur tous les registres. Ensuite, ce qu'enregistre un
   * plugin pendant son onload est tamponne, et filtre s'il est desactive.
   */
  attachActivation(activation: PluginActivation): void {
    this.activation = activation
    for (const registry of [this.blocks, this.hooks, this.commands, this.files, this.slash, this.triggers, this.toolbar, this.index]) {
      if (registry) registry.activation = activation
    }
    ;(this.views as { _setActivation?: (a: PluginActivation) => void })._setActivation?.(activation)
  }

  activation?: PluginActivation

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
