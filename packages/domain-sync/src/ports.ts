// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import type { AccountId, DocumentId, DocumentMeta, DocumentUpdate, UserId, VaultId } from './types'
import type { Account } from './Account'
import type { Vault } from './Vault'
import type { Document } from './Document'
import type { DocumentSession } from './DocumentSession'

export interface IAccountRepository {
  getById(accountId: AccountId): Promise<Account | undefined>
  save(account: Account): Promise<void>
}

export interface IVaultRepository {
  listByAccount(accountId: AccountId): Promise<Vault[]>
  getById(vaultId: VaultId): Promise<Vault | undefined>
  save(vault: Vault): Promise<void>
  delete(vaultId: VaultId): Promise<void>
}

export interface IDocumentRepository {
  listByVault(vaultId: VaultId): Promise<DocumentMeta[]>
  getById(vaultId: VaultId, documentId: DocumentId): Promise<Document | undefined>
  getByPath(vaultId: VaultId, path: string): Promise<Document | undefined>
  save(vaultId: VaultId, document: Document): Promise<void>
  delete(vaultId: VaultId, documentId: DocumentId): Promise<void>
}

export interface IContentStore {
  readText(vaultId: VaultId, documentId: DocumentId): Promise<string>
  writeText(vaultId: VaultId, documentId: DocumentId, content: string): Promise<void>
}

export interface IDocumentSyncSessionRepository {
  get(vaultId: VaultId, documentId: DocumentId): Promise<DocumentSession | undefined>
  save(session: DocumentSession): Promise<void>
  remove(vaultId: VaultId, documentId: DocumentId): Promise<void>
}

export interface IDocumentSyncGateway {
  connect(vaultId: VaultId, documentId: DocumentId, userId: UserId): Promise<void>
  disconnect(vaultId: VaultId, documentId: DocumentId): Promise<void>
  push(update: DocumentUpdate): Promise<void>
  onRemoteUpdate(cb: (update: DocumentUpdate) => void): () => void
}

