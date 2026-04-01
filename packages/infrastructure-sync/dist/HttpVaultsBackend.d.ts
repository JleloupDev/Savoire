import type { AppDocumentSummary, AppVaultSummary, IVaultsBackend } from '@poc/application';
export interface HttpVaultsBackendOptions {
    baseUrl?: string;
    fetchFn?: typeof fetch;
}
export declare class HttpVaultsBackend implements IVaultsBackend {
    private readonly baseUrl;
    private readonly fetchFn;
    constructor(options?: HttpVaultsBackendOptions);
    listVaults(userId: string, token: string): Promise<AppVaultSummary[]>;
    createVault(userId: string, name: string, token: string): Promise<AppVaultSummary>;
    renameVault(vaultId: string, name: string, token: string): Promise<AppVaultSummary>;
    deleteVault(vaultId: string, token: string): Promise<void>;
    listDocuments(vaultId: string, token: string): Promise<AppDocumentSummary[]>;
    addMember(vaultId: string, userId: string, role: string, token: string): Promise<void>;
    removeMember(vaultId: string, memberId: string, token: string): Promise<void>;
    private requestJson;
    private resolve;
}
//# sourceMappingURL=HttpVaultsBackend.d.ts.map