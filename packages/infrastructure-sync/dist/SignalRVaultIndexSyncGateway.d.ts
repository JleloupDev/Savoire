import type { DocumentMeta, IVaultIndexSyncGateway } from '@poc/domain-sync';
export interface SignalRVaultIndexSyncGatewayOptions {
    serverUrl?: string;
    getToken?: () => string | null | undefined;
}
export declare class SignalRVaultIndexSyncGateway implements IVaultIndexSyncGateway {
    private readonly serverUrl;
    private readonly getToken;
    private connection;
    private joinedVaultId;
    private readonly snapshotListeners;
    private readonly createdListeners;
    private readonly renamedListeners;
    private readonly deletedListeners;
    constructor(options?: SignalRVaultIndexSyncGatewayOptions);
    connect(vaultId: string): Promise<void>;
    disconnect(_vaultId: string): Promise<void>;
    onSnapshot(cb: (docs: DocumentMeta[]) => void): () => void;
    onCreated(cb: (meta: DocumentMeta) => void): () => void;
    onRenamed(cb: (documentId: string, newPath: string) => void): () => void;
    onDeleted(cb: (documentId: string) => void): () => void;
    private ensureConnection;
}
//# sourceMappingURL=SignalRVaultIndexSyncGateway.d.ts.map