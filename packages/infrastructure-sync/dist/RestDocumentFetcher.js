export class RestDocumentFetcher {
    baseUrl;
    fetchFn;
    constructor(options = {}) {
        this.baseUrl = options.baseUrl ?? '';
        this.fetchFn = options.fetchFn ?? globalThis.fetch.bind(globalThis);
    }
    async getDocumentContent(vaultId, docId, token) {
        const res = await this.fetchFn(this.resolve(`/api/v1/vaults/${encodeURIComponent(vaultId)}/documents/${encodeURIComponent(docId)}/content`), { method: 'GET', headers: { Authorization: `Bearer ${token}` } });
        if (res.status === 404)
            return '';
        if (!res.ok)
            throw new Error(`${res.status}`);
        return res.text();
    }
    resolve(path) {
        return this.baseUrl ? `${this.baseUrl}${path}` : path;
    }
}
//# sourceMappingURL=RestDocumentFetcher.js.map