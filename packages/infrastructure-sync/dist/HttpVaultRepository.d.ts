import type { IVaultRepository, Vault } from '@poc/domain-sync';
import { type HttpClientOptions } from './http';
export interface HttpVaultRepositoryOptions extends HttpClientOptions {
}
export declare class HttpVaultRepository implements IVaultRepository {
    private readonly http;
    constructor(options?: HttpVaultRepositoryOptions);
    listByAccount(accountId: string): Promise<Vault[]>;
    getById(vaultId: string): Promise<Vault | undefined>;
    save(vault: Vault): Promise<void>;
    delete(vaultId: string): Promise<void>;
}
//# sourceMappingURL=HttpVaultRepository.d.ts.map