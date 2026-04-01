import { ConnectivityState, ReplicationMode, SyncState, UpdateSource } from './enums';
function assertDocId(expected, actual) {
    if (expected !== actual) {
        throw new Error(`Document id mismatch: expected ${expected}, got ${actual}`);
    }
}
export class DocumentSession {
    sessionId;
    documentId;
    vaultId;
    replicationMode;
    syncState;
    connectivityState;
    version;
    pendingLocalUpdates;
    appliedRemoteUpdateIds;
    constructor(params) {
        this.sessionId = params.sessionId;
        this.documentId = params.documentId;
        this.vaultId = params.vaultId;
        this.replicationMode = params.replicationMode ?? ReplicationMode.Bidirectional;
        this.syncState = params.syncState ?? SyncState.NotInitialized;
        this.connectivityState = params.connectivityState ?? ConnectivityState.Offline;
        this.version = params.version ?? 0;
        this.pendingLocalUpdates = [...(params.pendingLocalUpdates ?? [])];
        this.appliedRemoteUpdateIds = new Set(params.appliedRemoteUpdateIds ?? []);
    }
    applyLocalUpdate(update) {
        assertDocId(this.documentId, update.documentId);
        if (update.source !== UpdateSource.Local) {
            throw new Error('applyLocalUpdate expects a local update');
        }
        this.pendingLocalUpdates.push(update);
        this.version += 1;
        this.syncState = SyncState.LocalPending;
    }
    applyRemoteUpdate(update) {
        assertDocId(this.documentId, update.documentId);
        if (update.source !== UpdateSource.Remote) {
            throw new Error('applyRemoteUpdate expects a remote update');
        }
        if (this.appliedRemoteUpdateIds.has(update.updateId))
            return;
        this.appliedRemoteUpdateIds.add(update.updateId);
        this.version += 1;
        if (this.pendingLocalUpdates.length === 0)
            this.syncState = SyncState.InSync;
    }
    ackLocalUpdate(updateId) {
        const idx = this.pendingLocalUpdates.findIndex(u => u.updateId === updateId);
        if (idx === -1)
            return;
        this.pendingLocalUpdates.splice(idx, 1);
        if (this.pendingLocalUpdates.length === 0)
            this.syncState = SyncState.InSync;
    }
    markConnected() {
        this.connectivityState = ConnectivityState.Online;
    }
    markDisconnected() {
        this.connectivityState = ConnectivityState.Offline;
    }
    markConnecting() {
        this.connectivityState = ConnectivityState.Connecting;
    }
    markConflict() {
        this.syncState = SyncState.Conflict;
    }
    markError() {
        this.syncState = SyncState.Error;
    }
    isDirty() {
        return this.pendingLocalUpdates.length > 0;
    }
}
//# sourceMappingURL=DocumentSession.js.map