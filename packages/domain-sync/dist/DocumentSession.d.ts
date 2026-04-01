import { ConnectivityState, ReplicationMode, SyncState } from './enums';
import type { DocumentId, DocumentUpdate, VaultId } from './types';
export declare class DocumentSession {
    readonly sessionId: string;
    readonly documentId: DocumentId;
    readonly vaultId: VaultId;
    replicationMode: ReplicationMode;
    syncState: SyncState;
    connectivityState: ConnectivityState;
    version: number;
    readonly pendingLocalUpdates: DocumentUpdate[];
    readonly appliedRemoteUpdateIds: Set<string>;
    constructor(params: {
        sessionId: string;
        documentId: DocumentId;
        vaultId: VaultId;
        replicationMode?: ReplicationMode;
        syncState?: SyncState;
        connectivityState?: ConnectivityState;
        version?: number;
        pendingLocalUpdates?: DocumentUpdate[];
        appliedRemoteUpdateIds?: Iterable<string>;
    });
    applyLocalUpdate(update: DocumentUpdate): void;
    applyRemoteUpdate(update: DocumentUpdate): void;
    ackLocalUpdate(updateId: string): void;
    markConnected(): void;
    markDisconnected(): void;
    markConnecting(): void;
    markConflict(): void;
    markError(): void;
    isDirty(): boolean;
}
//# sourceMappingURL=DocumentSession.d.ts.map