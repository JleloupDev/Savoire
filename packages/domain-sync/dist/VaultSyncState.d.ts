import { SyncState } from './enums';
export declare class VaultSyncState {
    syncState: SyncState;
    lastSyncedAt: Date | null;
    syncError: string | null;
    constructor(syncState?: SyncState, lastSyncedAt?: Date | null, syncError?: string | null);
    markInSync(at: Date): void;
    markSyncing(): void;
    markOutOfSync(reason: string): void;
    markConflict(reason: string): void;
    markError(reason: string): void;
}
//# sourceMappingURL=VaultSyncState.d.ts.map