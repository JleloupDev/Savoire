import type { BlockRegistry, CommandRegistry, EditorPositionAPI, FileTypeRegistry, HookRegistry, IPluginAPI, IPluginBlocksAPI, IPluginCommandsAPI, IPluginEditorAPI, IPluginHooksAPI, IPluginSlashAPI, IPluginToolbarAPI, IPluginTriggersAPI, IPluginVaultAPI, IPluginViewsAPI, IPluginWorkspaceAPI, SlashRegistry, ToolbarCommandRegistry, TriggerRegistry, VaultAPI, ViewRegistry, WorkspaceAPI } from '@poc/plugin-api';
export declare class PluginVaultAPIAdapter implements IPluginVaultAPI {
    private readonly inner;
    constructor(inner: VaultAPI);
    read(documentId: string): Promise<string>;
    readDocumentByPath(path: string): Promise<string>;
    write(documentId: string, content: string): Promise<void>;
    list(dir?: string): Promise<string[]>;
    exists(documentId: string): Promise<boolean>;
    resolveDocumentId(path: string): string | undefined;
    createFile(path: string): Promise<void>;
    createFolder(path: string): Promise<void>;
    renameFile(documentId: string, newPath: string): Promise<void>;
    deleteFile(documentId: string): Promise<void>;
    deleteFolder(path: string): Promise<void>;
    getVaultId(): string;
    getToken(): string;
}
export declare class PluginWorkspaceAPIAdapter implements IPluginWorkspaceAPI {
    private readonly inner;
    constructor(inner: WorkspaceAPI);
    openFile(path: string): Promise<void>;
    openPanel(panelId: string): void;
    closePanel(panelId: string): void;
    getActiveDocument(): import("@poc/plugin-api").ViewDocument | undefined;
    subscribeVaultChange(cb: () => void): () => void;
    notifyVaultChange(): void;
    subscribeOpenFile(cb: (path: string) => void): () => void;
    subscribeDocumentIndexed(cb: (docId: string, path: string) => void): () => void;
}
export declare class PluginCommandsAPIAdapter implements IPluginCommandsAPI {
    private readonly inner;
    constructor(inner: CommandRegistry);
    register(command: Parameters<CommandRegistry['register']>[0]): void;
    unregister(id: string): void;
}
export declare class PluginViewsAPIAdapter implements IPluginViewsAPI {
    private readonly inner;
    constructor(inner: ViewRegistry);
    register(spec: Parameters<ViewRegistry['register']>[0]): void;
    unregister(id: string): void;
    getAll(): import("@poc/plugin-api").ViewSpec[];
}
export declare class PluginBlocksAPIAdapter implements IPluginBlocksAPI {
    private readonly inner;
    constructor(inner: BlockRegistry);
    register(spec: Parameters<BlockRegistry['register']>[0]): void;
    unregister(type: string): void;
    detectBlock(text: string): {
        type: string;
        spec: import("@poc/plugin-api").BlockSpec;
    } | null;
    getAll(): import("@poc/plugin-api").BlockSpec[];
}
export declare class PluginSlashAPIAdapter implements IPluginSlashAPI {
    private readonly inner;
    constructor(inner: SlashRegistry);
    register(item: Parameters<SlashRegistry['register']>[0]): void;
    unregister(id: string): void;
    getAll(): import("@poc/plugin-api").SlashCommandItem[];
}
export declare class PluginTriggersAPIAdapter implements IPluginTriggersAPI {
    private readonly inner;
    constructor(inner: TriggerRegistry);
    register(trigger: Parameters<TriggerRegistry['register']>[0]): void;
    unregister(id: string): void;
    getAll(): import("@poc/plugin-api").InputTrigger[];
    findConflict(character: string): import("@poc/plugin-api").InputTrigger | undefined;
}
export declare class PluginEditorAPIAdapter implements IPluginEditorAPI {
    private readonly inner;
    constructor(inner: EditorPositionAPI);
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
export declare class PluginToolbarAPIAdapter implements IPluginToolbarAPI {
    private readonly inner;
    constructor(inner: ToolbarCommandRegistry);
    register(cmd: Parameters<ToolbarCommandRegistry['register']>[0]): void;
    unregister(id: string): void;
    getAll(): import("@poc/plugin-api").ToolbarCommand[];
    getByGroup(group: string): import("@poc/plugin-api").ToolbarCommand[];
}
export declare class PluginHooksAPIAdapter implements IPluginHooksAPI {
    private readonly inner;
    constructor(inner: HookRegistry);
    beforeParse(hook: Parameters<HookRegistry['beforeParse']>[0]): void;
    afterParse(hook: Parameters<HookRegistry['afterParse']>[0]): void;
    beforeRender(hook: Parameters<HookRegistry['beforeRender']>[0]): void;
    afterRender(hook: Parameters<HookRegistry['afterRender']>[0]): void;
    onDocumentOpen(hook: Parameters<HookRegistry['onDocumentOpen']>[0]): void;
    onDocumentSave(hook: Parameters<HookRegistry['onDocumentSave']>[0]): void;
    onSelectionChange(hook: Parameters<HookRegistry['onSelectionChange']>[0]): void;
    runBeforeParse(source: string): Promise<string>;
    runBeforeParseSync(source: string): string;
    runAfterRender(html: string): Promise<string>;
    onDocumentStabilized(hook: Parameters<HookRegistry['onDocumentStabilized']>[0]): void;
    runDocumentOpen(path: string): void;
    runDocumentSave(content: string): void;
    runDocumentStabilized(docId: string, path: string, content: string): void;
}
export interface PluginAPIAdapterDeps {
    vault: VaultAPI;
    workspace: WorkspaceAPI;
    commands: CommandRegistry;
    views: ViewRegistry;
    blocks: BlockRegistry;
    hooks: HookRegistry;
    files: FileTypeRegistry;
    slash: SlashRegistry;
    triggers: TriggerRegistry;
    editor?: EditorPositionAPI;
    toolbar?: ToolbarCommandRegistry;
}
export declare class PluginAPIAdapter implements IPluginAPI {
    readonly vault: IPluginVaultAPI;
    readonly workspace: IPluginWorkspaceAPI;
    readonly commands: IPluginCommandsAPI;
    readonly views: IPluginViewsAPI;
    readonly blocks: IPluginBlocksAPI;
    readonly hooks: IPluginHooksAPI;
    readonly files: FileTypeRegistry;
    readonly slash: IPluginSlashAPI;
    readonly triggers: IPluginTriggersAPI;
    readonly editor: IPluginEditorAPI;
    readonly toolbar: IPluginToolbarAPI;
    constructor(deps: PluginAPIAdapterDeps);
}
//# sourceMappingURL=PluginAPIAdapter.d.ts.map