export class PluginVaultAPIAdapter {
    inner;
    constructor(inner) {
        this.inner = inner;
    }
    read(documentId) { return this.inner.read(documentId); }
    readDocumentByPath(path) { return this.inner.readDocumentByPath(path); }
    write(documentId, content) { return this.inner.write(documentId, content); }
    list(dir) { return this.inner.list(dir); }
    exists(documentId) { return this.inner.exists(documentId); }
    resolveDocumentId(path) { return this.inner.resolveDocumentId(path); }
    createFile(path) { return this.inner.createFile?.(path) ?? Promise.resolve(); }
    createFolder(path) { return this.inner.createFolder?.(path) ?? Promise.resolve(); }
    renameFile(documentId, newPath) {
        return this.inner.renameFile?.(documentId, newPath) ?? Promise.resolve();
    }
    deleteFile(documentId) { return this.inner.deleteFile?.(documentId) ?? Promise.resolve(); }
    deleteFolder(path) { return this.inner.deleteFolder?.(path) ?? Promise.resolve(); }
    getVaultId() { return this.inner.getVaultId?.() ?? ''; }
    getToken() { return this.inner.getToken?.() ?? ''; }
}
export class PluginWorkspaceAPIAdapter {
    inner;
    constructor(inner) {
        this.inner = inner;
    }
    openFile(path) { return this.inner.openFile(path); }
    openPanel(panelId) { this.inner.openPanel(panelId); }
    closePanel(panelId) { this.inner.closePanel(panelId); }
    getActiveDocument() { return this.inner.getActiveDocument(); }
    subscribeVaultChange(cb) { return this.inner.subscribeVaultChange?.(cb) ?? (() => { }); }
    notifyVaultChange() { this.inner.notifyVaultChange?.(); }
    subscribeOpenFile(cb) {
        return this.inner.subscribeOpenFile?.(cb) ?? (() => { });
    }
    subscribeDocumentIndexed(cb) {
        return this.inner.subscribeDocumentIndexed?.(cb) ?? (() => { });
    }
}
export class PluginCommandsAPIAdapter {
    inner;
    constructor(inner) {
        this.inner = inner;
    }
    register(command) { this.inner.register(command); }
    unregister(id) { this.inner.unregister(id); }
}
export class PluginViewsAPIAdapter {
    inner;
    constructor(inner) {
        this.inner = inner;
    }
    register(spec) { this.inner.register(spec); }
    unregister(id) { this.inner.unregister(id); }
    getAll() { return this.inner.getAll(); }
}
export class PluginBlocksAPIAdapter {
    inner;
    constructor(inner) {
        this.inner = inner;
    }
    register(spec) { this.inner.register(spec); }
    unregister(type) { this.inner.unregister(type); }
    detectBlock(text) { return this.inner.detectBlock(text); }
    getAll() { return this.inner.getAll(); }
}
export class PluginSlashAPIAdapter {
    inner;
    constructor(inner) {
        this.inner = inner;
    }
    register(item) { this.inner.register(item); }
    unregister(id) { this.inner.unregister(id); }
    getAll() { return this.inner.getAll(); }
}
export class PluginTriggersAPIAdapter {
    inner;
    constructor(inner) {
        this.inner = inner;
    }
    register(trigger) { this.inner.register(trigger); }
    unregister(id) { this.inner.unregister(id); }
    getAll() { return this.inner.getAll(); }
    findConflict(character) { return this.inner.findConflict(character); }
}
export class PluginEditorAPIAdapter {
    inner;
    constructor(inner) {
        this.inner = inner;
    }
    getCursorCoords() { return this.inner.getCursorCoords(); }
    getSelectionCoords() { return this.inner.getSelectionCoords(); }
    getSelectionText() { return this.inner.getSelectionText(); }
}
export class PluginToolbarAPIAdapter {
    inner;
    constructor(inner) {
        this.inner = inner;
    }
    register(cmd) { this.inner.register(cmd); }
    unregister(id) { this.inner.unregister(id); }
    getAll() { return this.inner.getAll(); }
    getByGroup(group) { return this.inner.getByGroup(group); }
}
export class PluginHooksAPIAdapter {
    inner;
    constructor(inner) {
        this.inner = inner;
    }
    beforeParse(hook) { this.inner.beforeParse(hook); }
    afterParse(hook) { this.inner.afterParse(hook); }
    beforeRender(hook) { this.inner.beforeRender(hook); }
    afterRender(hook) { this.inner.afterRender(hook); }
    onDocumentOpen(hook) { this.inner.onDocumentOpen(hook); }
    onDocumentSave(hook) { this.inner.onDocumentSave(hook); }
    onSelectionChange(hook) { this.inner.onSelectionChange(hook); }
    runBeforeParse(source) { return this.inner.runBeforeParse(source); }
    runBeforeParseSync(source) { return this.inner.runBeforeParseSync(source); }
    runAfterRender(html) { return this.inner.runAfterRender(html); }
    onDocumentStabilized(hook) { this.inner.onDocumentStabilized(hook); }
    runDocumentOpen(path) { this.inner.runDocumentOpen(path); }
    runDocumentSave(content) { this.inner.runDocumentSave(content); }
    runDocumentStabilized(docId, path, content) { this.inner.runDocumentStabilized(docId, path, content); }
}
export class PluginAPIAdapter {
    vault;
    workspace;
    commands;
    views;
    blocks;
    hooks;
    files;
    slash;
    triggers;
    editor;
    toolbar;
    constructor(deps) {
        this.vault = new PluginVaultAPIAdapter(deps.vault);
        this.workspace = new PluginWorkspaceAPIAdapter(deps.workspace);
        this.commands = new PluginCommandsAPIAdapter(deps.commands);
        this.views = new PluginViewsAPIAdapter(deps.views);
        this.blocks = new PluginBlocksAPIAdapter(deps.blocks);
        this.hooks = new PluginHooksAPIAdapter(deps.hooks);
        this.files = deps.files;
        this.slash = new PluginSlashAPIAdapter(deps.slash);
        this.triggers = new PluginTriggersAPIAdapter(deps.triggers);
        // editor and toolbar default to stubs when not provided (e.g. in tests)
        this.editor = new PluginEditorAPIAdapter(deps.editor ?? {
            getCursorCoords: () => null,
            getSelectionCoords: () => null,
            getSelectionText: () => '',
        });
        this.toolbar = new PluginToolbarAPIAdapter(deps.toolbar ?? {
            register: () => { },
            unregister: () => { },
            getAll: () => [],
            getByGroup: () => [],
        });
    }
}
//# sourceMappingURL=PluginAPIAdapter.js.map