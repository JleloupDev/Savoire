/**
 * Platform ports — interfaces définies par la couche platform.
 *
 *
 * IDocumentMeta est intentionnellement minimal : la platform ne connaît pas DocumentDto
 * (DTO spécifique à l'API REST). Toute app qui implémente `id` + `path` est compatible.
 */
/** Interface minimale requise par la platform — sous-ensemble de DocumentDto. */
export interface IDocumentMeta {
    id: string;
    path: string;
}
/** Port : chargement/écriture du contenu textuel d'un document depuis n'importe quelle source. */
export interface IDocumentFetcher {
    getDocumentContent(vaultId: string, docId: string, token: string): Promise<string>;
    writeDocumentContent(vaultId: string, docId: string, content: string, token: string): Promise<void>;
}
/**
 * Port : persistance des snapshots d'index local.
 * POC : InMemoryIndexStorage. Production : IndexedDB ou SQLite.
 */
export interface ILocalIndexStorage {
    /** Charge le dernier snapshot pour un namespace. Retourne null si aucun n'existe. */
    loadSnapshot(namespace: string): Promise<{
        data: string;
        seq: number;
    } | null>;
    /** Persiste un snapshot pour un namespace. */
    saveSnapshot(namespace: string, data: string, seq: number): Promise<void>;
}
/** Port : lecture/écriture de fichiers dans un vault (attachments, notes). */
export interface IVaultStorage {
    readFile(vaultId: string, path: string, token: string): Promise<string>;
    writeFile(vaultId: string, path: string, content: string, token: string): Promise<void>;
    resolveFileUrl(vaultId: string, path: string): string;
    listDocuments(vaultId: string, token: string): Promise<IDocumentMeta[]>;
    createDocument(vaultId: string, path: string, token: string): Promise<IDocumentMeta>;
    renameDocument(vaultId: string, docId: string, path: string, token: string): Promise<void>;
    deleteDocument(vaultId: string, docId: string, token: string): Promise<void>;
    createFolder(vaultId: string, path: string, token: string): Promise<void>;
    deleteFolder(vaultId: string, path: string, token: string): Promise<void>;
    listFolders(vaultId: string, token: string): Promise<string[]>;
    /** Upload a binary file; returns { fileName (original name), storagePath (GUID-based server path) }. */
    uploadAttachment(vaultId: string, file: File, token: string): Promise<{
        fileName: string;
        storagePath: string;
    }>;
}
//# sourceMappingURL=ports.d.ts.map