export class HttpClient {
    baseUrl;
    getToken;
    fetchFn;
    constructor(options = {}) {
        this.baseUrl = options.baseUrl ?? '';
        this.getToken = options.getToken ?? (() => null);
        this.fetchFn = options.fetchFn ?? globalThis.fetch.bind(globalThis);
    }
    async getJson(path) {
        return this.requestJson(path, { method: 'GET' });
    }
    async postJson(path, body) {
        return this.requestJson(path, { method: 'POST', body: JSON.stringify(body) });
    }
    async patchJson(path, body) {
        return this.requestJson(path, { method: 'PATCH', body: JSON.stringify(body) });
    }
    async putText(path, body) {
        const headers = this.makeHeaders({ 'Content-Type': 'text/markdown' });
        const res = await this.fetchFn(this.resolve(path), { method: 'PUT', headers, body });
        if (!res.ok)
            throw new Error(`HTTP ${res.status}`);
    }
    async getText(path) {
        const res = await this.fetchFn(this.resolve(path), { method: 'GET', headers: this.makeHeaders() });
        if (res.status === 404)
            return '';
        if (!res.ok)
            throw new Error(`HTTP ${res.status}`);
        return res.text();
    }
    async delete(path) {
        const res = await this.fetchFn(this.resolve(path), { method: 'DELETE', headers: this.makeHeaders() });
        if (!res.ok && res.status !== 204)
            throw new Error(`HTTP ${res.status}`);
    }
    async requestJson(path, init) {
        const res = await this.fetchFn(this.resolve(path), {
            ...init,
            headers: this.makeHeaders({ 'Content-Type': 'application/json', ...init.headers }),
        });
        if (!res.ok)
            throw new Error(`HTTP ${res.status}`);
        return res.json();
    }
    makeHeaders(extra = {}) {
        const token = this.getToken();
        return {
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
            ...extra,
        };
    }
    resolve(path) {
        if (!this.baseUrl)
            return path;
        return `${this.baseUrl}${path}`;
    }
}
//# sourceMappingURL=http.js.map