import type { VaultClient } from '@poc/platform';
import type { IVaultHubFactory, VaultHubLike } from './contracts';
export declare class SyncOrchestrator {
    private readonly hubFactory;
    private activeHub;
    private activeVaultId;
    constructor(hubFactory: IVaultHubFactory);
    attachVaultSync(vaultId: string, vaultClient: VaultClient, onChanged: () => void): Promise<VaultHubLike>;
    disposeActive(): Promise<void>;
}
//# sourceMappingURL=SyncOrchestrator.d.ts.map