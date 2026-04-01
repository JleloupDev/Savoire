import { VaultClient, type DocumentStore, type IDocumentMeta, type IVaultStorage } from '@poc/platform';
import type { ActivatedVault, AppDocumentSummary, IDocumentsAPI, IVaultsBackend } from './contracts';
import { SyncOrchestrator } from './SyncOrchestrator';
export declare class DocumentsService implements IDocumentsAPI {
    private readonly backend;
    private readonly sync;
    private active;
    constructor(backend: IVaultsBackend, sync: SyncOrchestrator);
    activateVault(params: {
        vaultId: string;
        token: string;
        storage: IVaultStorage;
        documentStore: DocumentStore;
        resolveDoc: (path: string) => IDocumentMeta | undefined;
        onChanged: () => void;
    }): Promise<ActivatedVault>;
    getActiveClient(): VaultClient | undefined;
    getActiveHub(): import('./contracts').VaultHubLike | null;
    list(vaultId: string, token: string): Promise<AppDocumentSummary[]>;
    disposeActiveVault(): Promise<void>;
}
//# sourceMappingURL=DocumentsService.d.ts.map