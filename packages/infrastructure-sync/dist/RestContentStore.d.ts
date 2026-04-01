import type { IContentStore } from '@poc/domain-sync';
import { type HttpClientOptions } from './http';
export interface RestContentStoreOptions extends HttpClientOptions {
}
export declare class RestContentStore implements IContentStore {
    private readonly http;
    constructor(options?: RestContentStoreOptions);
    readText(vaultId: string, documentId: string): Promise<string>;
    writeText(vaultId: string, documentId: string, content: string): Promise<void>;
}
//# sourceMappingURL=RestContentStore.d.ts.map