import { type DocumentUpdate, type IDocumentSyncGateway } from '@poc/domain-sync';
export interface SignalRDocumentSyncGatewayOptions {
    serverUrl?: string;
    getToken?: () => string | null | undefined;
    clientId?: string;
}
export declare class SignalRDocumentSyncGateway implements IDocumentSyncGateway {
    private readonly serverUrl;
    private readonly getToken;
    private readonly clientId;
    private connection;
    private connectedUserId;
    private readonly activeDocuments;
    private readonly listeners;
    constructor(options?: SignalRDocumentSyncGatewayOptions);
    connect(vaultId: string, documentId: string, userId: string): Promise<void>;
    disconnect(vaultId: string, documentId: string): Promise<void>;
    push(update: DocumentUpdate): Promise<void>;
    onRemoteUpdate(cb: (update: DocumentUpdate) => void): () => void;
    private ensureConnection;
}
//# sourceMappingURL=SignalRDocumentSyncGateway.d.ts.map