/**
 * VaultClient — abstraction du stockage de fichiers vault.
 *
 * readDocumentByPath(path) :
 *   1. Si le chemin correspond à un document connu → DocumentStore.readContent()
 *      (cache-first, endpoint /documents/{id}/content — masque sync/pas-sync)
 *   2. Sinon → IVaultStorage.readFile() (attachments : images, PDF…)
 *
 * Les plugins ![[...]] et @[[...]] ne savent rien de cette logique.
 */
import type { VaultAPI } from '@poc/plugin-api';
import type { IDocumentMeta, IVaultStorage } from './ports';
import type { DocumentStore } from './DocumentStore';
export declare class VaultClient implements VaultAPI {
    private readonly vaultId;
    private token;
    private readonly storage;
    private readonly documentStore;
    /** Résout un chemin relatif en IDocumentMeta — fourni par l'app layer. */
    private readonly resolveDoc;
    private readonly _documentsById;
    private readonly _explicitFolders;
    private _onChangeCallbacks;
    private _pendingFileCreates;
    constructor(vaultId: string, token: string, storage: IVaultStorage, documentStore: DocumentStore, 
    /** Résout un chemin relatif en IDocumentMeta — fourni par l'app layer. */
    resolveDoc: (path: string) => IDocumentMeta | undefined);
    /** Met à jour le token Bearer (appelé après refresh du token d'accès). */
    setToken(token: string): void;
    /** Replace the entire cache — called on VaultHub snapshot. */
    setSnapshot(docs: IDocumentMeta[]): void;
    /** Add a document to the cache (optimistic or from hub event). */
    addDocument(doc: IDocumentMeta): void;
    /** Remove a document from the cache by id. */
    removeDocument(id: string): void;
    /** Rename a document in the cache. */
    renameDocumentInCache(id: string, newPath: string): void;
    /** Subscribe to cache changes — returns unsubscribe function. */
    onChange(cb: () => void): () => void;
    /** Get current cached documents. */
    get documents(): readonly IDocumentMeta[];
    private _notifyChange;
    read(documentId: string): Promise<string>;
    readDocumentByPath(path: string): Promise<string>;
    write(documentId: string, content: string): Promise<void>;
    list(dir?: string): Promise<string[]>;
    /** Charge les dossiers depuis le backend — appeler après activation du vault. */
    loadFolders(): Promise<void>;
    exists(documentId: string): Promise<boolean>;
    resolveDocumentId(path: string): string | undefined;
    getVaultId(): string;
    getToken(): string;
    createFile(path: string): Promise<void>;
    createFolder(path: string): Promise<void>;
    renameFile(documentId: string, newPath: string): Promise<void>;
    deleteFile(documentId: string): Promise<void>;
    deleteFolder(path: string): Promise<void>;
    uploadAttachment(file: File): Promise<string>;
    resolveAttachmentUrl(path: string): string;
    renameDocument(documentId: string, newPath: string): Promise<void>;
    deleteDocument(documentId: string): Promise<void>;
    private _isConflictError;
    private _resolveDocumentByPath;
    private _findDocumentByPath;
}
//# sourceMappingURL=VaultClient.d.ts.map