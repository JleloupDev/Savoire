// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import type { BlockRegistry, CommandRegistry, FileTypeRegistry, HookRegistry, IPluginAPI, IPluginBlocksAPI, IPluginCommandsAPI, IPluginHooksAPI, IPluginVaultAPI, IPluginViewsAPI, IPluginWorkspaceAPI, VaultAPI, ViewRegistry, WorkspaceAPI } from '@savoire/plugin-api';
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
}
export declare class PluginWorkspaceAPIAdapter implements IPluginWorkspaceAPI {
    private readonly inner;
    constructor(inner: WorkspaceAPI);
    openFile(path: string): Promise<void>;
    openPanel(panelId: string): void;
    closePanel(panelId: string): void;
    getActiveDocument(): import("@savoire/plugin-api").ViewDocument | undefined;
    subscribeVaultChange(cb: () => void): () => void;
    notifyVaultChange(): void;
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
    getAll(): import("@savoire/plugin-api").ViewSpec[];
}
export declare class PluginBlocksAPIAdapter implements IPluginBlocksAPI {
    private readonly inner;
    constructor(inner: BlockRegistry);
    register(spec: Parameters<BlockRegistry['register']>[0]): void;
    unregister(type: string): void;
    detectBlock(text: string): {
        type: string;
        spec: import("@savoire/plugin-api").BlockSpec;
    } | null;
    getAll(): import("@savoire/plugin-api").BlockSpec[];
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
    runDocumentOpen(path: string): void;
    runDocumentSave(content: string): void;
}
export interface PluginAPIAdapterDeps {
    vault: VaultAPI;
    workspace: WorkspaceAPI;
    commands: CommandRegistry;
    views: ViewRegistry;
    blocks: BlockRegistry;
    hooks: HookRegistry;
    files: FileTypeRegistry;
}
export declare class PluginAPIAdapter implements IPluginAPI {
    readonly vault: IPluginVaultAPI;
    readonly workspace: IPluginWorkspaceAPI;
    readonly commands: IPluginCommandsAPI;
    readonly views: IPluginViewsAPI;
    readonly blocks: IPluginBlocksAPI;
    readonly hooks: IPluginHooksAPI;
    readonly files: FileTypeRegistry;
    constructor(deps: PluginAPIAdapterDeps);
}
//# sourceMappingURL=PluginAPIAdapter.d.ts.map