import type { DocumentStore, IDocumentMeta } from '@poc/platform';
import type { IDocumentSessionAPI } from './contracts';
export declare class DocumentSessionService implements IDocumentSessionAPI {
    private readonly store;
    constructor(store: DocumentStore);
    open(vaultId: string, docId: string, metadata: IDocumentMeta, token: string): Promise<string>;
    close(vaultId: string, docId: string): void;
    read(vaultId: string, docId: string, token: string): Promise<string>;
}
//# sourceMappingURL=DocumentSessionService.d.ts.map