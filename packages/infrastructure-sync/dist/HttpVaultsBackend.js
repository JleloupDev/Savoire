export class HttpVaultsBackend {
    baseUrl;
    fetchFn;
    constructor(options = {}) {
        this.baseUrl = options.baseUrl ?? '';
        this.fetchFn = options.fetchFn ?? globalThis.fetch.bind(globalThis);
    }
    listVaults(userId, token) {
        return this.requestJson(`/api/v1/users/${encodeURIComponent(userId)}/vaults`, token, { method: 'GET' });
    }
    createVault(userId, name, token) {
        return this.requestJson(`/api/v1/users/${encodeURIComponent(userId)}/vaults`, token, { method: 'POST', body: JSON.stringify({ name }) });
    }
    renameVault(vaultId, name, token) {
        return this.requestJson(`/api/v1/vaults/${encodeURIComponent(vaultId)}`, token, { method: 'PATCH', body: JSON.stringify({ name }) });
    }
    deleteVault(vaultId, token) {
        return this.requestJson(`/api/v1/vaults/${encodeURIComponent(vaultId)}`, token, { method: 'DELETE' });
    }
    listDocuments(vaultId, token) {
        return this.requestJson(`/api/v1/vaults/${encodeURIComponent(vaultId)}/documents`, token, { method: 'GET' }).then(list => list.map(d => ({ id: d.id, path: d.path })));
    }
    addMember(vaultId, userId, role, token) {
        return this.requestJson(`/api/v1/vaults/${encodeURIComponent(vaultId)}/members`, token, { method: 'POST', body: JSON.stringify({ userId, role }) });
    }
    removeMember(vaultId, memberId, token) {
        return this.requestJson(`/api/v1/vaults/${encodeURIComponent(vaultId)}/members/${encodeURIComponent(memberId)}`, token, { method: 'DELETE' });
    }
    async requestJson(path, token, init) {
        const res = await this.fetchFn(this.resolve(path), {
            ...init,
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${token}`,
                ...(init.headers ?? {}),
            },
        });
        if (!res.ok) {
            const body = await res.text().catch(() => '');
            throw new Error(`${res.status}: ${body}`);
        }
        if (res.status === 204)
            return undefined;
        return res.json();
    }
    resolve(path) {
        return this.baseUrl ? `${this.baseUrl}${path}` : path;
    }
}
//# sourceMappingURL=HttpVaultsBackend.js.map