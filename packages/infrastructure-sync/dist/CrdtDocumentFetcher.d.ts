import { HubConnection } from '@microsoft/signalr';
import type { IDocumentFetcher } from '@poc/platform';
export interface CrdtDocumentFetcherOptions {
    serverUrl?: string;
    getToken?: () => string | null;
    getUserId?: () => string;
    /** Injecté en test pour remplacer HubConnectionBuilder. */
    connectionFactory?: (serverUrl: string, getToken: () => string | null, userId: string) => HubConnection;
}
export declare class CrdtDocumentFetcher implements IDocumentFetcher {
    private readonly serverUrl;
    private readonly getToken;
    private readonly getUserId;
    private readonly connectionFactory;
    private connection;
    private readonly docs;
    constructor(options?: CrdtDocumentFetcherOptions);
    getDocumentContent(vaultId: string, docId: string, _token: string): Promise<string>;
    private ensureConnection;
}
//# sourceMappingURL=CrdtDocumentFetcher.d.ts.map