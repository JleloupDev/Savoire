import { HubConnectionBuilder, HubConnectionState, LogLevel, } from '@microsoft/signalr';
import { mapDocumentMeta } from './mappers';
export class SignalRVaultIndexSyncGateway {
    serverUrl;
    getToken;
    connection = null;
    joinedVaultId = null;
    snapshotListeners = new Set();
    createdListeners = new Set();
    renamedListeners = new Set();
    deletedListeners = new Set();
    constructor(options = {}) {
        this.serverUrl = options.serverUrl ?? '';
        this.getToken = options.getToken ?? (() => null);
    }
    async connect(vaultId) {
        const conn = this.ensureConnection();
        if (conn.state === HubConnectionState.Disconnected)
            await conn.start();
        await conn.invoke('JoinVault', vaultId);
        this.joinedVaultId = vaultId;
    }
    async disconnect(_vaultId) {
        if (!this.connection)
            return;
        if (this.connection.state !== HubConnectionState.Disconnected)
            await this.connection.stop();
        this.connection = null;
        this.joinedVaultId = null;
    }
    onSnapshot(cb) {
        this.snapshotListeners.add(cb);
        return () => {
            this.snapshotListeners.delete(cb);
        };
    }
    onCreated(cb) {
        this.createdListeners.add(cb);
        return () => {
            this.createdListeners.delete(cb);
        };
    }
    onRenamed(cb) {
        this.renamedListeners.add(cb);
        return () => {
            this.renamedListeners.delete(cb);
        };
    }
    onDeleted(cb) {
        this.deletedListeners.add(cb);
        return () => {
            this.deletedListeners.delete(cb);
        };
    }
    ensureConnection() {
        if (this.connection)
            return this.connection;
        this.connection = new HubConnectionBuilder()
            .withUrl(`${this.serverUrl}/hubs/vault`, {
            accessTokenFactory: () => this.getToken() ?? '',
        })
            .configureLogging(LogLevel.None)
            .withAutomaticReconnect()
            .build();
        this.connection.on('VaultSnapshot', (items) => {
            const metas = items.map(i => mapDocumentMeta(i));
            for (const l of this.snapshotListeners)
                l(metas);
        });
        this.connection.on('DocumentCreated', (evt) => {
            const meta = mapDocumentMeta(evt);
            for (const l of this.createdListeners)
                l(meta);
        });
        this.connection.on('DocumentRenamed', (evt) => {
            const documentId = str(evt.id ?? evt.Id);
            const newPath = str(evt.newPath ?? evt.NewPath);
            for (const l of this.renamedListeners)
                l(documentId, newPath);
        });
        this.connection.on('DocumentDeleted', (evt) => {
            const documentId = str(evt.id ?? evt.Id);
            for (const l of this.deletedListeners)
                l(documentId);
        });
        this.connection.onreconnected(async () => {
            if (!this.connection || !this.joinedVaultId)
                return;
            await this.connection.invoke('JoinVault', this.joinedVaultId);
        });
        return this.connection;
    }
}
function str(value) {
    return typeof value === 'string' ? value : '';
}
//# sourceMappingURL=SignalRVaultIndexSyncGateway.js.map