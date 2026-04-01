// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
export interface PluginManifest {
    id: string;
    name: string;
    version: string;
    description?: string;
    author?: string;
    permissions?: PluginPermission[];
}
export type PluginPermission = 'vault:read' | 'vault:write' | 'network:*' | 'ui:editor' | 'ui:settings';
export interface VaultPlugin {
    manifest: PluginManifest;
    onload(api: PluginAPI): Promise<void>;
    onunload(): Promise<void>;
}
export interface IPluginVaultAPI extends VaultAPI {
}
export interface IPluginWorkspaceAPI extends WorkspaceAPI {
}
export interface IPluginCommandsAPI extends CommandRegistry {
}
export interface IPluginViewsAPI extends ViewRegistry {
}
export interface IPluginBlocksAPI extends BlockRegistry {
}
export interface IPluginHooksAPI extends HookRegistry {
}
export interface IPluginAPI {
    commands: IPluginCommandsAPI;
    hooks: IPluginHooksAPI;
    blocks: IPluginBlocksAPI;
    files: FileTypeRegistry;
    vault: IPluginVaultAPI;
    workspace: IPluginWorkspaceAPI;
    views: IPluginViewsAPI;
}
export interface PluginAPI extends IPluginAPI {
}
export interface PluginCommandContext {
    /** Raw editor view — typed as unknown to avoid direct CM6 dependency in plugin-api */
    editorView: unknown;
}
export interface PluginCommand {
    id: string;
    label?: string;
    run(context: PluginCommandContext): void;
}
export interface CommandRegistry {
    register(command: PluginCommand): void;
    unregister(id: string): void;
}
export type HookStage = 'beforeParse' | 'afterParse' | 'beforeRender' | 'afterRender' | 'onDocumentOpen' | 'onDocumentSave' | 'onSelectionChange';
export interface HookRegistry {
    beforeParse(hook: (source: string) => string | Promise<string>): void;
    afterParse(hook: (ast: unknown) => unknown | Promise<unknown>): void;
    beforeRender(hook: (ast: unknown) => unknown | Promise<unknown>): void;
    afterRender(hook: (html: string) => string | Promise<string>): void;
    onDocumentOpen(hook: (path: string) => void): void;
    onDocumentSave(hook: (path: string) => void): void;
    onSelectionChange(hook: (selection: unknown) => void): void;
    runBeforeParse(source: string): Promise<string>;
    runBeforeParseSync(source: string): string;
    runAfterRender(html: string): Promise<string>;
    runDocumentOpen(path: string): void;
    runDocumentSave(content: string): void;
}
export interface BlockWidget {
    mount(container: HTMLElement): void;
    destroy(): void;
}
export interface BlockContext {
    editorView: unknown;
}
export interface BlockSpec {
    type: string;
    detect?: RegExp | ((text: string) => boolean);
    serialize(data: unknown): string;
    deserialize(raw: string): unknown;
    createEditorWidget(data: unknown, ctx: BlockContext): BlockWidget;
    renderClient(data: unknown, ctx: BlockContext): HTMLElement;
}
export interface BlockRegistry {
    register(spec: BlockSpec): void;
    unregister(type: string): void;
    detectBlock(text: string): {
        type: string;
        spec: BlockSpec;
    } | null;
    getAll(): BlockSpec[];
}
export interface FileContext {
    vaultId: string;
    path: string;
}
export interface FileView {
    mount(container: HTMLElement): void;
    destroy(): void;
}
export interface FileTypeSpec {
    extension: string;
    label: string;
    icon: string;
    create(): Promise<string>;
    open(path: string, ctx: FileContext): FileView;
}
export interface FileTypeRegistry {
    register(spec: FileTypeSpec): void;
    unregister(extension: string): void;
}
export interface VaultAPI {
    read(documentId: string): Promise<string>;
    /** Seule exception path-based: lecture d'un document/attachment via son chemin. */
    readDocumentByPath(path: string): Promise<string>;
    write(documentId: string, content: string): Promise<void>;
    list(dir?: string): Promise<string[]>;
    exists(documentId: string): Promise<boolean>;
    /** Resolve a vault-relative path to a document id when possible. */
    resolveDocumentId(path: string): string | undefined;
    createFile?(path: string): Promise<void>;
    createFolder?(path: string): Promise<void>;
    renameFile?(documentId: string, newPath: string): Promise<void>;
    deleteFile?(documentId: string): Promise<void>;
    deleteFolder?(path: string): Promise<void>;
}
export interface ViewDocument {
    path: string;
    content: string;
}
export interface WorkspaceAPI {
    openFile(path: string): Promise<void>;
    openPanel(panelId: string): void;
    closePanel(panelId: string): void;
    getActiveDocument(): ViewDocument | undefined;
    /** Subscribe to vault-change events (fired when selected vault changes). */
    subscribeVaultChange?(cb: () => void): () => void;
    /** Notify all vault-change subscribers. */
    notifyVaultChange?(): void;
}
export interface Widget {
    /** Returns React.ReactNode in practice — typed unknown to avoid React dep in plugin-api. */
    render(): unknown;
    dispose?(): void;
}
export interface ViewContext {
    workspace: WorkspaceAPI;
    vault: VaultAPI;
}
export interface ViewSpec {
    id: string;
    title: string;
    icon?: string;
    /** 'left' | 'right' | 'bottom' | 'center' */
    container: string;
    /** If set, panel is added as a tab next to this panel ID (same group). */
    tabOf?: string;
    /** If set, panel is placed below this panel ID (split horizontally). */
    belowOf?: string;
    /** false = no close button (permanent panel). Default: true */
    closable?: boolean;
    /** Initial size in px — width for left/right, height for bottom. */
    initialSize?: number;
    createView(ctx: ViewContext): Widget;
}
export interface ViewRegistry {
    register(spec: ViewSpec): void;
    unregister(id: string): void;
    getAll(): ViewSpec[];
}
//# sourceMappingURL=types.d.ts.map