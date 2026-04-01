export class DocumentSessionService {
    store;
    constructor(store) {
        this.store = store;
    }
    async open(vaultId, docId, metadata, token) {
        const opened = await this.store.open(vaultId, docId, metadata, token);
        return opened.content;
    }
    close(vaultId, docId) {
        this.store.close(vaultId, docId);
    }
    read(vaultId, docId, token) {
        return this.store.readContent(vaultId, docId, token);
    }
}
//# sourceMappingURL=DocumentSessionService.js.map