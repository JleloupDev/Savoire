// DECISION: IDocumentFetcher implémenté via CRDT (SignalR) au lieu de REST.
// Point d'entrée unique pour l'éditeur ET les embeds — le texte est toujours
// reconstruit depuis les opérations Yjs en mémoire.
//
// Cache illimité pour le POC : chaque document rejoint reste en mémoire et
// continue de recevoir les ReceiveOperation. Optimisation (LRU, LeaveDocument)
// à prévoir plus tard.
import * as Y from 'yjs';
import { HubConnectionBuilder, HubConnectionState, } from '@microsoft/signalr';
import { base64ToBytes } from './base64';
function defaultConnectionFactory(serverUrl, getToken, userId) {
    return new HubConnectionBuilder()
        .withUrl(`${serverUrl}/hubs/sync?userId=${encodeURIComponent(userId)}`, {
        accessTokenFactory: () => getToken() ?? '',
    })
        .withAutomaticReconnect()
        .build();
}
export class CrdtDocumentFetcher {
    serverUrl;
    getToken;
    getUserId;
    connectionFactory;
    connection = null;
    // DECISION: pas de LRU — cache illimité pour le POC, à optimiser plus tard.
    docs = new Map();
    constructor(options = {}) {
        this.serverUrl = options.serverUrl ?? '';
        this.getToken = options.getToken ?? (() => null);
        this.getUserId = options.getUserId ?? (() => 'reader');
        this.connectionFactory = options.connectionFactory ?? defaultConnectionFactory;
    }
    async getDocumentContent(vaultId, docId, _token) {
        const existing = this.docs.get(docId);
        if (existing) {
            if (!existing.ready)
                await existing.initPromise;
            return existing.ydoc.getText('codemirror').toString();
        }
        const ydoc = new Y.Doc();
        let resolveInit;
        const initPromise = new Promise(r => { resolveInit = r; });
        const entry = { ydoc, ready: false, initPromise, resolveInit };
        this.docs.set(docId, entry);
        const conn = await this.ensureConnection();
        await conn.invoke('JoinDocument', vaultId, docId);
        await initPromise;
        return ydoc.getText('codemirror').toString();
    }
    async ensureConnection() {
        if (this.connection && this.connection.state !== HubConnectionState.Disconnected) {
            return this.connection;
        }
        const userId = this.getUserId();
        this.connection = this.connectionFactory(this.serverUrl, this.getToken, userId);
        this.connection.on('InitDocument', (docId, opsBase64) => {
            const entry = this.docs.get(docId);
            if (!entry)
                return;
            for (const opBase64 of opsBase64) {
                try {
                    Y.applyUpdate(entry.ydoc, base64ToBytes(opBase64));
                }
                catch { /* POC: ignoré — op corrompue */ }
            }
            entry.ready = true;
            entry.resolveInit();
        });
        this.connection.on('ReceiveOperation', (docId, _clientId, opBase64) => {
            const entry = this.docs.get(docId);
            if (!entry?.ready)
                return;
            try {
                Y.applyUpdate(entry.ydoc, base64ToBytes(opBase64));
            }
            catch { /* POC: ignoré — op corrompue */ }
        });
        await this.connection.start();
        return this.connection;
    }
}
//# sourceMappingURL=CrdtDocumentFetcher.js.map