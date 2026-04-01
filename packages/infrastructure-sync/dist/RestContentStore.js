import { HttpClient } from './http';
export class RestContentStore {
    http;
    constructor(options = {}) {
        this.http = new HttpClient(options);
    }
    readText(vaultId, documentId) {
        return this.http.getText(`/api/v1/vaults/${encodeURIComponent(vaultId)}/documents/${encodeURIComponent(documentId)}/content`);
    }
    writeText(vaultId, documentId, content) {
        return this.http.putText(`/api/v1/vaults/${encodeURIComponent(vaultId)}/documents/${encodeURIComponent(documentId)}/content`, content);
    }
}
//# sourceMappingURL=RestContentStore.js.map