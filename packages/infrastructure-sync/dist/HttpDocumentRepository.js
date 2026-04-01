import { HttpClient } from './http';
import { mapDocument, mapDocumentMeta } from './mappers';
export class HttpDocumentRepository {
    http;
    constructor(options = {}) {
        this.http = new HttpClient(options);
    }
    async listByVault(vaultId) {
        const list = await this.http.getJson(`/api/v1/vaults/${encodeURIComponent(vaultId)}/documents`);
        return list.map(mapDocumentMeta);
    }
    async getById(vaultId, documentId) {
        const docs = await this.http.getJson(`/api/v1/vaults/${encodeURIComponent(vaultId)}/documents`);
        const found = docs.find(d => str(d.id ?? d.Id) === documentId);
        if (!found)
            return undefined;
        const content = await this.http.getText(`/api/v1/vaults/${encodeURIComponent(vaultId)}/documents/${encodeURIComponent(documentId)}/content`);
        return mapDocument(found, content);
    }
    async getByPath(vaultId, path) {
        const docs = await this.http.getJson(`/api/v1/vaults/${encodeURIComponent(vaultId)}/documents`);
        const found = docs.find(d => str(d.path ?? d.Path) === path);
        if (!found)
            return undefined;
        const docId = str(found.id ?? found.Id);
        const content = await this.http.getText(`/api/v1/vaults/${encodeURIComponent(vaultId)}/documents/${encodeURIComponent(docId)}/content`);
        return mapDocument(found, content);
    }
    async save(vaultId, document) {
        await this.http.putText(`/api/v1/vaults/${encodeURIComponent(vaultId)}/documents/${encodeURIComponent(document.id)}/content`, document.content);
        await this.http.patchJson(`/api/v1/vaults/${encodeURIComponent(vaultId)}/documents/${encodeURIComponent(document.id)}`, { path: document.path });
    }
    async delete(vaultId, documentId) {
        await this.http.delete(`/api/v1/vaults/${encodeURIComponent(vaultId)}/documents/${encodeURIComponent(documentId)}`);
    }
}
function str(value) {
    return typeof value === 'string' ? value : '';
}
//# sourceMappingURL=HttpDocumentRepository.js.map