import type { IDocumentFetcher } from '@poc/platform';
export interface RestDocumentFetcherOptions {
    baseUrl?: string;
    fetchFn?: typeof fetch;
}
export declare class RestDocumentFetcher implements IDocumentFetcher {
    private readonly baseUrl;
    private readonly fetchFn;
    constructor(options?: RestDocumentFetcherOptions);
    getDocumentContent(vaultId: string, docId: string, token: string): Promise<string>;
    private resolve;
}
//# sourceMappingURL=RestDocumentFetcher.d.ts.map