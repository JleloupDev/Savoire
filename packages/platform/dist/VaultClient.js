export class VaultClient {
    vaultId;
    token;
    storage;
    documentStore;
    resolveDoc;
    // see ADR-010
    _documentsById = new Map();
    // see ADR-010
    _explicitFolders = new Set();
    _onChangeCallbacks = [];
    _pendingFileCreates = new Map();
    constructor(vaultId, token, storage, documentStore, 
    /** Résout un chemin relatif en IDocumentMeta — fourni par l'app layer. */
    resolveDoc) {
        this.vaultId = vaultId;
        this.token = token;
        this.storage = storage;
        this.documentStore = documentStore;
        this.resolveDoc = resolveDoc;
    }
    /** Met à jour le token Bearer (appelé après refresh du token d'accès). */
    setToken(token) {
        this.token = token;
    }
    // ── Cache management (called by VaultHubClient or after REST mutations) ──
    /** Replace the entire cache — called on VaultHub snapshot. */
    setSnapshot(docs) {
        this._documentsById.clear();
        for (const doc of docs)
            this._documentsById.set(doc.id, doc);
        this._notifyChange();
    }
    /** Add a document to the cache (optimistic or from hub event). */
    addDocument(doc) {
        // Deduplicate: if doc already exists, skip
        if (this._documentsById.has(doc.id))
            return;
        this._documentsById.set(doc.id, doc);
        this._notifyChange();
    }
    /** Remove a document from the cache by id. */
    removeDocument(id) {
        if (this._documentsById.delete(id))
            this._notifyChange();
    }
    /** Rename a document in the cache. */
    renameDocumentInCache(id, newPath) {
        const doc = this._documentsById.get(id);
        if (!doc)
            return;
        this._documentsById.set(id, { ...doc, path: newPath });
        this._notifyChange();
    }
    /** Subscribe to cache changes — returns unsubscribe function. */
    onChange(cb) {
        this._onChangeCallbacks.push(cb);
        return () => {
            this._onChangeCallbacks = this._onChangeCallbacks.filter(c => c !== cb);
        };
    }
    /** Get current cached documents. */
    get documents() {
        return Array.from(this._documentsById.values());
    }
    _notifyChange() {
        for (const cb of this._onChangeCallbacks)
            cb();
    }
    async read(documentId) {
        const meta = this._documentsById.get(documentId);
        return this.documentStore.readContent(this.vaultId, documentId, this.token, meta);
    }
    async readDocumentByPath(path) {
        const doc = this._resolveDocumentByPath(path);
        if (doc) {
            const ext = path.split('.').at(-1) ?? '';
            if (ext !== 'md')
                return this.documentStore.readDirect(this.vaultId, doc.id, this.token);
            return this.documentStore.readContent(this.vaultId, doc.id, this.token, doc);
        }
        // Fallback : attachments (images, PDFs, fichiers non-.md)
        return this.storage.readFile(this.vaultId, path, this.token);
    }
    async write(documentId, content) {
        const doc = this._documentsById.get(documentId);
        if (!doc)
            throw new Error(`Document not found: ${documentId}`);
        await this.documentStore.writeContent(this.vaultId, documentId, content, this.token);
    }
    // see ADR-010
    async list(dir) {
        const prefix = !dir ? '' : dir.endsWith('/') ? dir : dir + '/';
        const result = new Set();
        for (const doc of this._documentsById.values()) {
            if (!doc.path.startsWith(prefix))
                continue;
            const rest = doc.path.slice(prefix.length);
            const slashIdx = rest.indexOf('/');
            if (slashIdx === -1)
                result.add(prefix + rest);
            else
                result.add(prefix + rest.slice(0, slashIdx) + '/');
        }
        for (const folderPath of this._explicitFolders) {
            if (!folderPath.startsWith(prefix))
                continue;
            const rest = folderPath.slice(prefix.length);
            if (!rest)
                continue;
            const slashIdx = rest.indexOf('/');
            result.add(slashIdx === -1 ? prefix + rest : prefix + rest.slice(0, slashIdx) + '/');
        }
        return Array.from(result).sort();
    }
    /** Charge les dossiers depuis le backend — appeler après activation du vault. */
    async loadFolders() {
        try {
            const paths = await this.storage.listFolders(this.vaultId, this.token);
            for (const p of paths)
                this._explicitFolders.add(p.endsWith('/') ? p : p + '/');
            this._notifyChange();
        }
        catch {
            // Folder list failure is non-fatal: folders with documents remain visible via their documents.
        }
    }
    async exists(documentId) {
        try {
            await this.read(documentId);
            return true;
        }
        catch {
            return false;
        }
    }
    resolveDocumentId(path) {
        return this._resolveDocumentByPath(path)?.id;
    }
    getVaultId() {
        return this.vaultId;
    }
    getToken() {
        return this.token;
    }
    async createFile(path) {
        const normalizedPath = path.includes('.') ? path : `${path}.md`;
        if (this._findDocumentByPath(path) || this._findDocumentByPath(normalizedPath))
            return;
        const pending = this._pendingFileCreates.get(normalizedPath);
        if (pending)
            return pending;
        const request = (async () => {
            try {
                const doc = await this.storage.createDocument(this.vaultId, path, this.token);
                // Optimistic cache update — VaultHub event from other clients handled separately
                this.addDocument(doc);
            }
            catch (err) {
                // Idempotent create: "already exists" is not a hard failure.
                if (this._isConflictError(err)) {
                    const existing = this.resolveDoc(path) ?? this.resolveDoc(normalizedPath);
                    if (existing)
                        this.addDocument(existing);
                    return;
                }
                throw err;
            }
            finally {
                this._pendingFileCreates.delete(normalizedPath);
            }
        })();
        this._pendingFileCreates.set(normalizedPath, request);
        return request;
    }
    async createFolder(path) {
        await this.storage.createFolder(this.vaultId, path, this.token);
        const normalized = path.endsWith('/') ? path : path + '/';
        this._explicitFolders.add(normalized);
        this._notifyChange();
    }
    async renameFile(documentId, newPath) {
        await this.renameDocument(documentId, newPath);
    }
    async deleteFile(documentId) {
        await this.deleteDocument(documentId);
    }
    async deleteFolder(path) {
        await this.storage.deleteFolder(this.vaultId, path, this.token);
        const prefix = path.endsWith('/') ? path : path + '/';
        for (const f of this._explicitFolders) {
            if (f === prefix || f.startsWith(prefix))
                this._explicitFolders.delete(f);
        }
        this._notifyChange();
    }
    async uploadAttachment(file) {
        const { storagePath } = await this.storage.uploadAttachment(this.vaultId, file, this.token);
        const docPath = `attachments/${storagePath}`;
        // Create a real document entry in the backend so the attachment persists across page refreshes.
        const doc = await this.storage.createDocument(this.vaultId, docPath, this.token);
        this.addDocument(doc);
        return docPath;
    }
    resolveAttachmentUrl(path) {
        const storagePath = path.startsWith('attachments/') ? path.slice('attachments/'.length) : path;
        return this.storage.resolveFileUrl(this.vaultId, storagePath);
    }
    async renameDocument(documentId, newPath) {
        const normalizedNewPath = newPath.includes('.') ? newPath : `${newPath}.md`;
        await this.storage.renameDocument(this.vaultId, documentId, normalizedNewPath, this.token);
        // Optimistic cache update
        this.renameDocumentInCache(documentId, normalizedNewPath);
    }
    async deleteDocument(documentId) {
        await this.storage.deleteDocument(this.vaultId, documentId, this.token);
        // Optimistic cache update
        this.removeDocument(documentId);
    }
    _isConflictError(err) {
        return err instanceof Error
            && (err.message.startsWith('409') || /conflict/i.test(err.message));
    }
    _resolveDocumentByPath(path) {
        const normalizedPath = path.includes('.') ? path : `${path}.md`;
        const doc = this.resolveDoc(path) ?? this.resolveDoc(normalizedPath);
        if (doc)
            this._documentsById.set(doc.id, doc);
        return doc;
    }
    _findDocumentByPath(path) {
        for (const doc of this._documentsById.values()) {
            if (doc.path === path)
                return doc;
        }
        return undefined;
    }
}
//# sourceMappingURL=VaultClient.js.map