import { HubConnectionBuilder, HubConnectionState, LogLevel, } from '@microsoft/signalr';
import { UpdateSource } from '@poc/domain-sync';
import { base64ToBytes, bytesToBase64 } from './base64';
export class SignalRDocumentSyncGateway {
    serverUrl;
    getToken;
    clientId;
    connection = null;
    connectedUserId = null;
    activeDocuments = new Map();
    listeners = new Set();
    constructor(options = {}) {
        this.serverUrl = options.serverUrl ?? '';
        this.getToken = options.getToken ?? (() => null);
        this.clientId = options.clientId ?? 'client';
    }
    async connect(vaultId, documentId, userId) {
        const conn = this.ensureConnection(userId);
        if (conn.state === HubConnectionState.Disconnected)
            await conn.start();
        await conn.invoke('JoinDocument', vaultId, documentId);
        this.activeDocuments.set(documentId, vaultId);
    }
    async disconnect(vaultId, documentId) {
        const conn = this.connection;
        if (!conn)
            return;
        try {
            await conn.invoke('LeaveDocument', vaultId, documentId);
        }
        catch {
            // Best-effort leave.
        }
        this.activeDocuments.delete(documentId);
        if (this.activeDocuments.size === 0 && conn.state !== HubConnectionState.Disconnected) {
            await conn.stop();
            this.connection = null;
            this.connectedUserId = null;
        }
    }
    async push(update) {
        const conn = this.connection;
        if (!conn || conn.state !== HubConnectionState.Connected)
            throw new Error('Sync gateway not connected');
        const vaultId = this.activeDocuments.get(update.documentId);
        if (!vaultId)
            throw new Error(`No active sync session for document ${update.documentId}`);
        await conn.invoke('PushOperation', vaultId, update.documentId, this.clientId, bytesToBase64(update.payload));
    }
    onRemoteUpdate(cb) {
        this.listeners.add(cb);
        return () => {
            this.listeners.delete(cb);
        };
    }
    ensureConnection(userId) {
        if (this.connection && this.connectedUserId === userId)
            return this.connection;
        if (this.connection && this.connectedUserId !== userId) {
            throw new Error('SignalRDocumentSyncGateway instance cannot switch userId after initialization');
        }
        this.connectedUserId = userId;
        this.connection = new HubConnectionBuilder()
            .withUrl(`${this.serverUrl}/hubs/sync?userId=${encodeURIComponent(userId)}`, {
            accessTokenFactory: () => this.getToken() ?? '',
        })
            .configureLogging(LogLevel.None)
            .withAutomaticReconnect()
            .build();
        this.connection.on('ReceiveOperation', (docId, _clientId, opBase64) => {
            const update = {
                updateId: `${docId}:${Date.now()}:${Math.random().toString(36).slice(2)}`,
                documentId: docId,
                source: UpdateSource.Remote,
                payload: base64ToBytes(opBase64),
                at: new Date(),
            };
            for (const listener of this.listeners)
                listener(update);
        });
        return this.connection;
    }
}
//# sourceMappingURL=SignalRDocumentSyncGateway.js.map