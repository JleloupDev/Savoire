export class RestVaultStorage {
    baseUrl;
    fetchFn;
    constructor(options = {}) {
        this.baseUrl = options.baseUrl ?? '';
        this.fetchFn = options.fetchFn ?? globalThis.fetch.bind(globalThis);
    }
    async readFile(vaultId, path, token) {
        const res = await this.fetchFn(this.resolve(`/api/v1/vaults/${encodeURIComponent(vaultId)}/attachments/${encodeURIComponent(path)}`), { method: 'GET', headers: { Authorization: `Bearer ${token}` } });
        if (!res.ok)
            throw new Error(`${res.status}`);
        return res.text();
    }
    async writeFile(vaultId, path, content, token) {
        const blob = new Blob([content], { type: 'text/markdown' });
        const file = new File([blob], path.split('/').at(-1) ?? 'file.md', { type: 'text/markdown' });
        const form = new FormData();
        form.append('file', file);
        const res = await this.fetchFn(this.resolve(`/api/v1/vaults/${encodeURIComponent(vaultId)}/attachments`), { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form });
        if (!res.ok)
            throw new Error(`${res.status}`);
    }
    resolveFileUrl(vaultId, path) {
        return this.resolve(`/api/v1/vaults/${encodeURIComponent(vaultId)}/attachments/${encodeURIComponent(path)}`);
    }
    async listDocuments(vaultId, token) {
        const res = await this.fetchFn(this.resolve(`/api/v1/vaults/${encodeURIComponent(vaultId)}/documents`), { method: 'GET', headers: { Authorization: `Bearer ${token}` } });
        if (!res.ok)
            throw new Error(`${res.status}`);
        return res.json();
    }
    async createDocument(vaultId, path, token) {
        const res = await this.fetchFn(this.resolve(`/api/v1/vaults/${encodeURIComponent(vaultId)}/documents`), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
            body: JSON.stringify({
                path,
                title: path.split('/').at(-1)?.replace(/\.md$/i, '') ?? 'New note',
            }),
        });
        if (!res.ok)
            throw new Error(`${res.status}`);
        return res.json();
    }
    async renameDocument(vaultId, docId, path, token) {
        const res = await this.fetchFn(this.resolve(`/api/v1/vaults/${encodeURIComponent(vaultId)}/documents/${encodeURIComponent(docId)}`), {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
            body: JSON.stringify({
                path,
                title: path.split('/').at(-1)?.replace(/\.md$/i, '') ?? '',
            }),
        });
        if (!res.ok)
            throw new Error(`${res.status}`);
    }
    async deleteDocument(vaultId, docId, token) {
        const res = await this.fetchFn(this.resolve(`/api/v1/vaults/${encodeURIComponent(vaultId)}/documents/${encodeURIComponent(docId)}`), { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
        if (!res.ok && res.status !== 204)
            throw new Error(`${res.status}`);
    }
    async createFolder(vaultId, path, token) {
        const res = await this.fetchFn(this.resolve(`/api/v1/vaults/${encodeURIComponent(vaultId)}/folders`), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
            body: JSON.stringify({ path }),
        });
        if (!res.ok)
            throw new Error(`${res.status}`);
    }
    async deleteFolder(vaultId, path, token) {
        const listRes = await this.fetchFn(this.resolve(`/api/v1/vaults/${encodeURIComponent(vaultId)}/folders`), { method: 'GET', headers: { Authorization: `Bearer ${token}` } });
        if (!listRes.ok)
            throw new Error(`${listRes.status}`);
        const folders = (await listRes.json());
        const normalized = path.replace(/\/$/, '');
        const folder = folders.find(f => f.path === path || f.path === normalized);
        if (!folder)
            return;
        const delRes = await this.fetchFn(this.resolve(`/api/v1/vaults/${encodeURIComponent(vaultId)}/folders/${encodeURIComponent(folder.id)}`), { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
        if (!delRes.ok && delRes.status !== 204)
            throw new Error(`${delRes.status}`);
    }
    resolve(path) {
        return this.baseUrl ? `${this.baseUrl}${path}` : path;
    }
}
//# sourceMappingURL=RestVaultStorage.js.map