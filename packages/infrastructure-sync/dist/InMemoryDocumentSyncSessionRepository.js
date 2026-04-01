function key(vaultId, documentId) {
    return `${vaultId}:${documentId}`;
}
export class InMemoryDocumentSyncSessionRepository {
    sessions = new Map();
    async get(vaultId, documentId) {
        return this.sessions.get(key(vaultId, documentId));
    }
    async save(session) {
        this.sessions.set(key(session.vaultId, session.documentId), session);
    }
    async remove(vaultId, documentId) {
        this.sessions.delete(key(vaultId, documentId));
    }
}
//# sourceMappingURL=InMemoryDocumentSyncSessionRepository.js.map