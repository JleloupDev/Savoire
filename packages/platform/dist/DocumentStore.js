/**
 * DocumentStore — gestion des documents ouverts en mémoire.
 *
 */
function key(vaultId, docId) {
    return `${vaultId}/${docId}`;
}
export class DocumentStore {
    fetcher;
    writer;
    // Cache of documents opened in the editor (key = `${vaultId}/${docId}`).
    cache = new Map();
    pending = new Map();
    constructor(fetcher, writer) {
        this.fetcher = fetcher;
        this.writer = writer;
    }
    async open(vaultId, docId, metadata, token) {
        const doc = await this.ensureCached(vaultId, docId, metadata, token);
        doc.refCount++;
        return doc;
    }
    /**
     * Lit le contenu d'un document sans modifier le refCount.
     * - Si le document est déjà en cache (ouvert dans l'éditeur) : retourne le contenu en mémoire.
     * - Sinon :
     *   - avec metadata : charge et garde en cache "passif" (refCount=0), utile pour les embeds.
     *   - sans metadata : charge via le fetcher sans cache durable.
     *
     * see ADR-010
     */
    async readContent(vaultId, docId, token, metadata) {
        const k = key(vaultId, docId);
        const cached = this.cache.get(k);
        if (cached) {
            // Keep authoritative cache only for actively opened docs.
            if (cached.refCount > 0)
                return cached.content;
            // Passive empty cache is often transient (404/content not yet available).
            if (cached.content !== '')
                return cached.content;
            this.cache.delete(k);
        }
        if (metadata) {
            const loaded = await this.ensureCached(vaultId, docId, metadata, token);
            if (loaded.refCount === 0 && loaded.content === '') {
                this.cache.delete(k);
            }
            return loaded.content;
        }
        return this.fetcher.getDocumentContent(vaultId, docId, token);
    }
    /** Lit directement via le writer (REST) sans passer par le CRDT. */
    async readDirect(vaultId, docId, token) {
        return (this.writer ?? this.fetcher).getDocumentContent(vaultId, docId, token);
    }
    async writeContent(vaultId, docId, content, token) {
        await (this.writer ?? this.fetcher).writeDocumentContent(vaultId, docId, content, token);
        // Update cache if doc is cached
        const k = key(vaultId, docId);
        const cached = this.cache.get(k);
        if (cached)
            cached.content = content;
    }
    close(vaultId, docId) {
        const k = key(vaultId, docId);
        const doc = this.cache.get(k);
        if (!doc)
            return;
        doc.refCount--;
        if (doc.refCount <= 0)
            this.cache.delete(k);
    }
    get(vaultId, docId) {
        return this.cache.get(key(vaultId, docId));
    }
    get size() {
        return this.cache.size;
    }
    async ensureCached(vaultId, docId, metadata, token) {
        const k = key(vaultId, docId);
        const cached = this.cache.get(k);
        if (cached)
            return cached;
        const pending = this.pending.get(k);
        if (pending)
            return pending;
        const request = (async () => {
            try {
                const content = await this.fetcher.getDocumentContent(vaultId, docId, token);
                const doc = { docId, path: metadata.path, content, metadata, refCount: 0 };
                this.cache.set(k, doc);
                return doc;
            }
            finally {
                this.pending.delete(k);
            }
        })();
        this.pending.set(k, request);
        return request;
    }
}
//# sourceMappingURL=DocumentStore.js.map