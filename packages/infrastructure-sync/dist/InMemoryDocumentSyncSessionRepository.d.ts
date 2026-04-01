import type { DocumentSession, IDocumentSyncSessionRepository } from '@poc/domain-sync';
export declare class InMemoryDocumentSyncSessionRepository implements IDocumentSyncSessionRepository {
    private readonly sessions;
    get(vaultId: string, documentId: string): Promise<DocumentSession | undefined>;
    save(session: DocumentSession): Promise<void>;
    remove(vaultId: string, documentId: string): Promise<void>;
}
//# sourceMappingURL=InMemoryDocumentSyncSessionRepository.d.ts.map