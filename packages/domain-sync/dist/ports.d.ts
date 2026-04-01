import type { AccountId, DocumentId, DocumentMeta, DocumentUpdate, UserId, VaultId, ApplyResult } from './types';
import type { Account } from './Account';
import type { Vault } from './Vault';
import type { Document } from './Document';
import type { DocumentSession } from './DocumentSession';
export interface IAccountRepository {
    getById(accountId: AccountId): Promise<Account | undefined>;
    save(account: Account): Promise<void>;
}
export interface IVaultRepository {
    listByAccount(accountId: AccountId): Promise<Vault[]>;
    getById(vaultId: VaultId): Promise<Vault | undefined>;
    save(vault: Vault): Promise<void>;
    delete(vaultId: VaultId): Promise<void>;
}
export interface IDocumentRepository {
    listByVault(vaultId: VaultId): Promise<DocumentMeta[]>;
    getById(vaultId: VaultId, documentId: DocumentId): Promise<Document | undefined>;
    getByPath(vaultId: VaultId, path: string): Promise<Document | undefined>;
    save(vaultId: VaultId, document: Document): Promise<void>;
    delete(vaultId: VaultId, documentId: DocumentId): Promise<void>;
}
export interface IContentStore {
    readText(vaultId: VaultId, documentId: DocumentId): Promise<string>;
    writeText(vaultId: VaultId, documentId: DocumentId, content: string): Promise<void>;
}
export interface IDocumentSyncSessionRepository {
    get(vaultId: VaultId, documentId: DocumentId): Promise<DocumentSession | undefined>;
    save(session: DocumentSession): Promise<void>;
    remove(vaultId: VaultId, documentId: DocumentId): Promise<void>;
}
export interface IDocumentSyncGateway {
    connect(vaultId: VaultId, documentId: DocumentId, userId: UserId): Promise<void>;
    disconnect(vaultId: VaultId, documentId: DocumentId): Promise<void>;
    push(update: DocumentUpdate): Promise<void>;
    onRemoteUpdate(cb: (update: DocumentUpdate) => void): () => void;
}
export interface IVaultIndexSyncGateway {
    connect(vaultId: VaultId): Promise<void>;
    disconnect(vaultId: VaultId): Promise<void>;
    onSnapshot(cb: (docs: DocumentMeta[]) => void): () => void;
    onCreated(cb: (meta: DocumentMeta) => void): () => void;
    onRenamed(cb: (documentId: DocumentId, newPath: string) => void): () => void;
    onDeleted(cb: (documentId: DocumentId) => void): () => void;
}
export interface ICollabDocumentEngine {
    applyLocal(payload: Uint8Array): ApplyResult;
    applyRemote(payload: Uint8Array): ApplyResult;
    getText(): string;
}
//# sourceMappingURL=ports.d.ts.map