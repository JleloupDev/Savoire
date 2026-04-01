import type { Document, DocumentMeta, IDocumentRepository } from '@poc/domain-sync';
import { type HttpClientOptions } from './http';
export interface HttpDocumentRepositoryOptions extends HttpClientOptions {
}
export declare class HttpDocumentRepository implements IDocumentRepository {
    private readonly http;
    constructor(options?: HttpDocumentRepositoryOptions);
    listByVault(vaultId: string): Promise<DocumentMeta[]>;
    getById(vaultId: string, documentId: string): Promise<Document | undefined>;
    getByPath(vaultId: string, path: string): Promise<Document | undefined>;
    save(vaultId: string, document: Document): Promise<void>;
    delete(vaultId: string, documentId: string): Promise<void>;
}
//# sourceMappingURL=HttpDocumentRepository.d.ts.map