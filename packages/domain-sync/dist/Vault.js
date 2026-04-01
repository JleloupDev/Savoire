import { ConnectivityState, ReplicationMode } from './enums';
import { VaultSyncState } from './VaultSyncState';
function trimNonEmpty(value, label) {
    const v = value.trim();
    if (!v)
        throw new Error(`${label} must not be empty`);
    return v;
}
export class Vault {
    id;
    name;
    replicationMode;
    connectivityState;
    sync;
    documents = new Map();
    constructor(params) {
        this.id = params.id;
        this.name = trimNonEmpty(params.name, 'name');
        this.replicationMode = params.replicationMode ?? ReplicationMode.Bidirectional;
        this.connectivityState = params.connectivityState ?? ConnectivityState.Offline;
        this.sync = params.sync ?? new VaultSyncState();
        for (const doc of params.documents ?? [])
            this.documents.set(doc.id, doc);
    }
    addDocument(document) {
        this.documents.set(document.id, document);
    }
    removeDocument(documentId) {
        this.documents.delete(documentId);
    }
    getDocument(documentId) {
        return this.documents.get(documentId);
    }
    listDocuments() {
        return Array.from(this.documents.values())
            .map(d => d.toMeta())
            .sort((a, b) => a.path.localeCompare(b.path));
    }
    rename(newName) {
        this.name = trimNonEmpty(newName, 'newName');
    }
    markOnline() {
        this.connectivityState = ConnectivityState.Online;
    }
    markOffline() {
        this.connectivityState = ConnectivityState.Offline;
    }
    markConnecting() {
        this.connectivityState = ConnectivityState.Connecting;
    }
    markInSync(at) {
        this.sync.markInSync(at);
    }
    markSyncing() {
        this.sync.markSyncing();
    }
    markOutOfSync(reason) {
        this.sync.markOutOfSync(reason);
    }
    markConflict(reason) {
        this.sync.markConflict(reason);
    }
    markError(reason) {
        this.sync.markError(reason);
    }
}
//# sourceMappingURL=Vault.js.map