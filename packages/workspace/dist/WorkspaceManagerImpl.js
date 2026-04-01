import { ViewRegistryImpl } from './ViewRegistryImpl';
/**
 * WorkspaceManager — orchestrates panels, views and layout.
 * Does NOT depend on Dockview directly; delegates to WorkspacePort.
 * DECISION: thin manager keeps layout logic testable without a DOM.
 */
export class WorkspaceManagerImpl {
    port;
    views;
    activeDocument;
    openFileCallbacks = [];
    vaultChangeCallbacks = [];
    constructor(port) {
        this.port = port;
        this.views = new ViewRegistryImpl();
    }
    async openFile(path) {
        this.activeDocument = { path, content: '' };
        this.port.openPanel('editor-area', { title: path });
        for (const cb of this.openFileCallbacks)
            cb(path);
    }
    /**
     * Subscribe to openFile events — used by EditorAreaWidget to know when
     * a file was selected in the filetree and load its content.
     * Returns an unsubscribe function.
     */
    subscribeOpenFile(cb) {
        this.openFileCallbacks.push(cb);
        return () => {
            this.openFileCallbacks = this.openFileCallbacks.filter(x => x !== cb);
        };
    }
    subscribeVaultChange(cb) {
        this.vaultChangeCallbacks.push(cb);
        return () => { this.vaultChangeCallbacks = this.vaultChangeCallbacks.filter(x => x !== cb); };
    }
    notifyVaultChange() {
        for (const cb of this.vaultChangeCallbacks)
            cb();
    }
    openPanel(panelId) {
        this.port.openPanel(panelId);
    }
    closePanel(panelId) {
        this.port.closePanel(panelId);
    }
    focusPanel(panelId) {
        this.port.focusPanel(panelId);
    }
    getActiveDocument() {
        return this.activeDocument;
    }
    saveLayout() {
        return this.port.saveLayout();
    }
    restoreLayout(layout) {
        this.port.restoreLayout(layout);
    }
}
//# sourceMappingURL=WorkspaceManagerImpl.js.map