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
    /** Subscribe to file-open events (fired when the user opens a document). */
    subscribeOpenFile?(cb: (path: string) => void): () => void;
    /** Subscribe to active-document changes (fired on tab switch AND file open). */
    subscribeActiveDocument?(cb: (path: string) => void): () => void;
    /** Subscribe to document-indexed events (fired after metadata extraction completes). */
    subscribeDocumentIndexed?(cb: (docId: string, path: string) => void): () => void;
}
//# sourceMappingURL=workspace.d.ts.map