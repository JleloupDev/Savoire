import { SyncState } from './enums';
export class VaultSyncState {
    syncState;
    lastSyncedAt;
    syncError;
    constructor(syncState = SyncState.NotInitialized, lastSyncedAt = null, syncError = null) {
        this.syncState = syncState;
        this.lastSyncedAt = lastSyncedAt;
        this.syncError = syncError;
    }
    markInSync(at) {
        this.syncState = SyncState.InSync;
        this.lastSyncedAt = at;
        this.syncError = null;
    }
    markSyncing() {
        this.syncState = SyncState.LocalPending;
        this.syncError = null;
    }
    markOutOfSync(reason) {
        this.syncState = SyncState.LocalPending;
        this.syncError = reason;
    }
    markConflict(reason) {
        this.syncState = SyncState.Conflict;
        this.syncError = reason;
    }
    markError(reason) {
        this.syncState = SyncState.Error;
        this.syncError = reason;
    }
}
//# sourceMappingURL=VaultSyncState.js.map