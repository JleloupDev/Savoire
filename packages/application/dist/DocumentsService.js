import { VaultClient } from '@poc/platform';
export class DocumentsService {
    backend;
    sync;
    active = null;
    constructor(backend, sync) {
        this.backend = backend;
        this.sync = sync;
    }
    async activateVault(params) {
        await this.disposeActiveVault();
        let hubRef = null;
        const s = params.storage;
        const storageWithHub = {
            readFile: (v, p, t) => s.readFile(v, p, t),
            writeFile: (v, p, c, t) => s.writeFile(v, p, c, t),
            resolveFileUrl: (v, p) => s.resolveFileUrl(v, p),
            listDocuments: (v, t) => s.listDocuments(v, t),
            createFolder: (v, p, t) => s.createFolder(v, p, t),
            deleteFolder: (v, p, t) => s.deleteFolder(v, p, t),
            createDocument: async (_vaultId, path) => {
                if (!hubRef)
                    throw new Error('Vault hub not attached');
                return hubRef.createDocument(path);
            },
            renameDocument: async (_vaultId, docId, path) => {
                if (!hubRef)
                    throw new Error('Vault hub not attached');
                await hubRef.renameDocument(docId, path);
            },
            deleteDocument: async (_vaultId, docId) => {
                if (!hubRef)
                    throw new Error('Vault hub not attached');
                await hubRef.deleteDocument(docId);
            },
            uploadAttachment: (v, f, t) => s.uploadAttachment(v, f, t),
            listFolders: (v, t) => s.listFolders(v, t),
        };
        const client = new VaultClient(params.vaultId, params.token, storageWithHub, params.documentStore, params.resolveDoc);
        const hub = await this.sync.attachVaultSync(params.vaultId, client, params.onChanged);
        hubRef = hub;
        void client.loadFolders();
        const active = {
            vaultId: params.vaultId,
            client,
            hub,
            dispose: async () => {
                await hub.dispose();
            },
        };
        this.active = active;
        return active;
    }
    getActiveClient() {
        return this.active?.client;
    }
    getActiveHub() {
        return this.active?.hub ?? null;
    }
    list(vaultId, token) {
        return this.backend.listDocuments(vaultId, token);
    }
    async disposeActiveVault() {
        if (!this.active)
            return;
        this.active = null;
        await this.sync.disposeActive();
    }
}
//# sourceMappingURL=DocumentsService.js.map