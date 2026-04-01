import { HttpClient } from './http';
import { mapVault } from './mappers';
export class HttpVaultRepository {
    http;
    constructor(options = {}) {
        this.http = new HttpClient(options);
    }
    async listByAccount(accountId) {
        const list = await this.http.getJson(`/api/v1/users/${encodeURIComponent(accountId)}/vaults`);
        return list.map(mapVault);
    }
    async getById(vaultId) {
        try {
            const dto = await this.http.getJson(`/api/v1/vaults/${encodeURIComponent(vaultId)}`);
            return mapVault(dto);
        }
        catch (err) {
            if (is404(err))
                return undefined;
            throw err;
        }
    }
    async save(vault) {
        await this.http.patchJson(`/api/v1/vaults/${encodeURIComponent(vault.id)}`, { name: vault.name });
    }
    async delete(vaultId) {
        await this.http.delete(`/api/v1/vaults/${encodeURIComponent(vaultId)}`);
    }
}
function is404(err) {
    return err instanceof Error && err.message.includes('404');
}
//# sourceMappingURL=HttpVaultRepository.js.map