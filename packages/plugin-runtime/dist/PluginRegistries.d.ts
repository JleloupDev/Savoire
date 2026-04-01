import type { BlockRegistry, BlockSpec, CommandRegistry, EditorPositionAPI, FileTypeRegistry, FileTypeSpec, HookRegistry, IEditorHostAPI, IIndexRegistry, IndexContributor, InputTrigger, PluginAPI, PluginCommand, SlashCommandItem, SlashRegistry, SyncAPI, ToolbarCommand, ToolbarCommandRegistry, TriggerRegistry, WorkspaceAPI, VaultAPI, ViewRegistry, ViewSpec } from '@poc/plugin-api';
export declare class TriggerRegistryImpl implements TriggerRegistry {
    private readonly triggers;
    register(trigger: InputTrigger): void;
    unregister(id: string): void;
    getAll(): InputTrigger[];
    findConflict(character: string): InputTrigger | undefined;
}
export declare class BlockRegistryImpl implements BlockRegistry {
    private readonly slashRegistry?;
    private readonly specEntries;
    _currentPluginId?: string;
    constructor(slashRegistry?: SlashRegistry | undefined);
    register(spec: BlockSpec): void;
    unregister(type: string): void;
    detectBlock(text: string): {
        type: string;
        spec: BlockSpec;
    } | null;
    detectActive(text: string, ids: Set<string> | null): {
        type: string;
        spec: BlockSpec;
    } | null;
    getAll(): BlockSpec[];
    getActive(ids: Set<string> | null): BlockSpec[];
}
type StrHook = (s: string) => string | Promise<string>;
type UnknownHook = (v: unknown) => unknown | Promise<unknown>;
type VoidHook<T> = (v: T) => void;
type StabilizedHook = (docId: string, path: string, content: string) => void;
export declare class HookRegistryImpl implements HookRegistry {
    private beforeParseHooks;
    private afterParseHooks;
    private beforeRenderHooks;
    private afterRenderHooks;
    private documentOpenHooks;
    private documentSaveHooks;
    private selectionChangeHooks;
    private documentStabilizedHooks;
    beforeParse(hook: StrHook): void;
    afterParse(hook: UnknownHook): void;
    beforeRender(hook: UnknownHook): void;
    afterRender(hook: StrHook): void;
    onDocumentOpen(hook: VoidHook<string>): void;
    onDocumentSave(hook: VoidHook<string>): void;
    onSelectionChange(hook: VoidHook<unknown>): void;
    onDocumentStabilized(hook: StabilizedHook): void;
    runBeforeParse(source: string): Promise<string>;
    runBeforeParseSync(source: string): string;
    runAfterRender(html: string): Promise<string>;
    runDocumentOpen(path: string): void;
    runDocumentSave(content: string): void;
    runDocumentStabilized(docId: string, path: string, content: string): void;
}
export declare class IndexRegistryImpl implements IIndexRegistry {
    private readonly contributors;
    register(contributor: IndexContributor): void;
    getAll(): IndexContributor[];
    get(namespace: string): IndexContributor | undefined;
}
export declare class CommandRegistryImpl implements CommandRegistry {
    private readonly commands;
    register(command: PluginCommand): void;
    unregister(id: string): void;
    execute(id: string, context: {
        editorView: unknown;
    }): void;
    getAll(): PluginCommand[];
}
export declare class FileTypeRegistryImpl implements FileTypeRegistry {
    private readonly specs;
    register(spec: FileTypeSpec): void;
    unregister(ext: string): void;
    resolve(ext: string): FileTypeSpec | undefined;
}
export declare class VaultAPIStub implements VaultAPI {
    read(_documentId: string): Promise<string>;
    readDocumentByPath(_path: string): Promise<string>;
    write(_documentId: string, _content: string): Promise<void>;
    list(_dir?: string): Promise<string[]>;
    exists(_documentId: string): Promise<boolean>;
    resolveDocumentId(_path: string): string | undefined;
}
export declare class WorkspaceAPIStub implements WorkspaceAPI {
    openFile(_path: string): Promise<void>;
    openPanel(_panelId: string): void;
    closePanel(_panelId: string): void;
    getActiveDocument(): undefined;
}
export declare class SlashRegistryImpl implements SlashRegistry {
    private readonly items;
    register(item: SlashCommandItem): void;
    unregister(id: string): void;
    getAll(): SlashCommandItem[];
}
export declare class ViewRegistryStub implements ViewRegistry {
    register(_spec: ViewSpec): void;
    unregister(_id: string): void;
    getAll(): ViewSpec[];
}
export declare class ToolbarCommandRegistryImpl implements ToolbarCommandRegistry {
    private cmds;
    register(cmd: ToolbarCommand): void;
    unregister(id: string): void;
    getAll(): ToolbarCommand[];
    getByGroup(group: string): ToolbarCommand[];
}
export declare class EditorPositionAPIStub implements EditorPositionAPI {
    getCursorCoords(): {
        x: number;
        y: number;
    } | null;
    getSelectionCoords(): {
        x: number;
        y: number;
    } | null;
    getSelectionText(): string;
}
export declare class PluginAPIImpl implements PluginAPI, IEditorHostAPI {
    readonly blocks: BlockRegistryImpl;
    readonly hooks: HookRegistryImpl;
    readonly commands: CommandRegistryImpl;
    readonly files: FileTypeRegistryImpl;
    readonly vault: VaultAPI;
    readonly workspace: WorkspaceAPI;
    readonly views: ViewRegistry;
    readonly slash: SlashRegistryImpl;
    readonly triggers: TriggerRegistryImpl;
    readonly toolbar: ToolbarCommandRegistryImpl;
    readonly sync?: SyncAPI | undefined;
    readonly index?: IndexRegistryImpl | undefined;
    editor: EditorPositionAPI;
    constructor(blocks: BlockRegistryImpl, hooks: HookRegistryImpl, commands: CommandRegistryImpl, files: FileTypeRegistryImpl, vault: VaultAPI, workspace: WorkspaceAPI, views: ViewRegistry, slash: SlashRegistryImpl, triggers: TriggerRegistryImpl, toolbar: ToolbarCommandRegistryImpl, editor?: EditorPositionAPI, sync?: SyncAPI | undefined, index?: IndexRegistryImpl | undefined);
    /** Called by EditorCore after the view is created to wire in the real position API. */
    setEditorPositionAPI(api: EditorPositionAPI): void;
    static create(vault?: VaultAPI, sync?: SyncAPI): PluginAPIImpl;
}
export {};
//# sourceMappingURL=PluginRegistries.d.ts.map