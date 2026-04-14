// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import type { DocumentStore, IDocumentMeta, IVaultStorage, VaultClient } from '@savoire/platform'
import type { VaultAPI } from '@savoire/plugin-api'

export interface AppVaultSummary {
  id: string
  name: string
  role: string
  documentCount: number
  folderCount: number
  lastModifiedAt: string | null
  sizeBytes: number
}

export interface AppDocumentSummary {
  id: string
  path: string
}

export interface AppSharedNote {
  documentId: string
  vaultId: string
  path: string
  permission: string
  grantedByDisplayName: string
}

export interface AppWorkspace {
  vaults: AppVaultSummary[]
  sharedWithMe: AppSharedNote[]
}

export interface VaultHubLike {
  connect(): Promise<void>
  dispose(): Promise<void>
  createDocument(path: string): Promise<IDocumentMeta>
  renameDocument(documentId: string, newPath: string): Promise<void>
  deleteDocument(documentId: string): Promise<void>
  /** Envoie une op d'index au serveur. Retourne le seq assigné, ou null si offline. */
  pushIndexOp?(docId: string, path: string, markdownContent: string): Promise<number | null>
  /** Subscribe aux ops d'index reçues des autres clients. */
  onIndexOpApplied?(cb: (evt: { seq: number; docId: string; path: string; markdownContent: string }) => void): () => void
}

export interface VaultHubFactoryParams {
  vaultId: string
  vaultClient: VaultClient
  onChanged: () => void
}

export interface IVaultHubFactory {
  create(params: VaultHubFactoryParams): VaultHubLike
}

export interface IVaultsBackend {
  listVaults(userId: string, token: string): Promise<AppWorkspace>
  createVault(userId: string, name: string, token: string): Promise<AppVaultSummary>
  renameVault(vaultId: string, name: string, token: string): Promise<AppVaultSummary>
  deleteVault(vaultId: string, token: string): Promise<void>
  listDocuments(vaultId: string, token: string): Promise<AppDocumentSummary[]>
  addMember(vaultId: string, userId: string, role: string, token: string): Promise<void>
  removeMember(vaultId: string, memberId: string, token: string): Promise<void>
}

export interface IVaultsAPI {
  list(userId: string, token: string): Promise<AppWorkspace>
  create(userId: string, name: string, token: string): Promise<AppVaultSummary>
  rename(vaultId: string, name: string, token: string): Promise<AppVaultSummary>
  delete(vaultId: string, token: string): Promise<void>
  addMember(vaultId: string, userId: string, role: string, token: string): Promise<void>
  removeMember(vaultId: string, memberId: string, token: string): Promise<void>
}

export interface ActivatedVault {
  readonly vaultId: string
  readonly client: VaultClient
  readonly hub: VaultHubLike
  dispose(): Promise<void>
}

export interface ActivateVaultParams {
  vaultId: string
  token: string
  storage: IVaultStorage
  documentStore: DocumentStore
  resolveDoc: (path: string) => IDocumentMeta | undefined
  onChanged: () => void
}

export interface ActivateSharedDocParams {
  vaultId: string
  doc: IDocumentMeta
  token: string
  documentStore: DocumentStore
  resolveDoc: (path: string) => IDocumentMeta | undefined
}

export interface IDocumentsAPI {
  activateVault(params: ActivateVaultParams): Promise<ActivatedVault>
  activateSharedDocument(params: ActivateSharedDocParams): Promise<ActivatedVault>
  getActiveClient(): VaultClient | undefined
  getActiveHub(): VaultHubLike | null
  list(vaultId: string, token: string): Promise<AppDocumentSummary[]>
  disposeActiveVault(): Promise<void>
}

export interface IDocumentSessionAPI {
  open(vaultId: string, docId: string, metadata: IDocumentMeta, token: string): Promise<string>
  close(vaultId: string, docId: string): void
  read(vaultId: string, docId: string, token: string): Promise<string>
}

export interface IWorkspaceAPI {
  createVaultProxy(
    getClient: () => VaultClient | undefined,
    resolveDocId: (path: string) => string | undefined,
  ): VaultAPI
}

export interface IApplicationAPI {
  vaults: IVaultsAPI
  documents: IDocumentsAPI
  documentSession: IDocumentSessionAPI
  workspace: IWorkspaceAPI
}
