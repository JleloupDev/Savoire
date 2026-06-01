// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import type { DocumentStore, IDocumentMeta, IVaultDirectory, IVaultStorage, VaultClient } from '@savoire/platform'
import type { ICRDT, ITransport, SyncAPI, VaultAPI, IIdentityProvider } from '@savoire/plugin-api'

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
  /** Pushes an index op to the server. Returns the assigned seq, or null if offline. */
  pushIndexOp?(docId: string, path: string, markdownContent: string): Promise<number | null>
  /** Subscribes to index ops received from other clients. */
  onIndexOpApplied?(cb: (evt: { seq: number; docId: string; path: string; markdownContent: string }) => void): () => void
  /** Push a binary vault CRDT update to other peers (wired when server supports it). */
  pushVaultUpdate?(update: Uint8Array): Promise<void>
  /** Subscribe to binary vault CRDT updates from other peers. */
  onVaultUpdate?(cb: (update: Uint8Array) => void): () => void
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
}

export interface IVaultsAPI {
  list(userId: string, token: string): Promise<AppWorkspace>
  create(userId: string, name: string, token: string): Promise<AppVaultSummary>
  rename(vaultId: string, name: string, token: string): Promise<AppVaultSummary>
  delete(vaultId: string, token: string): Promise<void>
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
  directory: IVaultDirectory
  resolveDoc: (path: string) => IDocumentMeta | undefined
  onChanged: () => void
}

export interface ActivateSharedDocParams {
  vaultId: string
  doc: IDocumentMeta
  token: string
  documentStore: DocumentStore
  directory: IVaultDirectory
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

// ── Auth ─────────────────────────────────────────────────────────────────────

export interface AppAuthUser {
  id: string
  displayName: string
  email: string
  isAdmin: boolean
}

export interface AppAuthResponse {
  accessToken: string
  refreshToken: string
  expiresIn: number
  user: AppAuthUser
}

export interface IAuthBackend {
  login(email: string, password: string): Promise<AppAuthResponse>
  refresh(refreshToken: string): Promise<AppAuthResponse>
  logout(accessToken: string, refreshToken: string): Promise<void>
  changePassword(token: string, currentPassword: string, newPassword: string): Promise<void>
}

export interface IAuthAPI {
  login(email: string, password: string): Promise<AppAuthResponse>
  refresh(refreshToken: string): Promise<AppAuthResponse>
  logout(accessToken: string, refreshToken: string): Promise<void>
  changePassword(token: string, currentPassword: string, newPassword: string): Promise<void>
}

// ── Sharing ───────────────────────────────────────────────────────────────────

export interface AppResourcePermission {
  id: string
  resourceType: string
  resourceId: string
  subjectType: string
  subjectId: string
  subjectDisplayName: string | null
  permission: string
  grantedBy: string
  grantedAt: string
  expiresAt: string | null
}

export interface AppShareLink {
  id: string
  token: string
  resourceType: string
  resourceId: string
  permission: string
  createdBy: string
  createdAt: string
  expiresAt: string | null
  revokedAt: string | null
  isValid: boolean
}

export interface AppResourceSharing {
  resourceType: string
  resourceId: string
  permissions: AppResourcePermission[]
  links: AppShareLink[]
}

export interface AppShareLinkAccess {
  accessToken: string
  resourceType: string
  resourceId: string
  permission: string
  expiresAt: string | null
  vaultId?: string
  path?: string
}

export interface SharedDocumentHandle {
  crdt: ICRDT
  transport: ITransport
  /** SyncAPI for snapshot-based plugins (excalidraw, mindmap). */
  sync: SyncAPI
  docId: string
  vaultId: string
  path: string
  filename: string
  permission: 'read' | 'write'
  accessToken: string
  dispose(): void
}

export interface AppUserLookup {
  id: string
  displayName: string
}

export interface ISharingBackend {
  getSharing(resourceType: 'vault' | 'document', id: string, token: string): Promise<AppResourceSharing>
  grantPermission(resourceType: 'vault' | 'document', id: string, subjectId: string, permission: string, token: string): Promise<AppResourcePermission>
  revokePermission(resourceType: 'vault' | 'document', id: string, targetUserId: string, token: string): Promise<void>
  lookupUserByEmail(email: string, token: string): Promise<AppUserLookup | null>
  createShareLink(resourceType: 'vault' | 'document', id: string, permission: string, token: string): Promise<AppShareLink>
  revokeShareLink(linkId: string, token: string): Promise<void>
  accessShareLink(shareToken: string): Promise<AppShareLinkAccess>
  openSharedDocument(shareToken: string): Promise<Omit<SharedDocumentHandle, 'dispose'>>
}

export interface ISharingAPI {
  getSharing(resourceType: 'vault' | 'document', id: string, token: string): Promise<AppResourceSharing>
  grantPermission(resourceType: 'vault' | 'document', id: string, subjectId: string, permission: string, token: string): Promise<AppResourcePermission>
  revokePermission(resourceType: 'vault' | 'document', id: string, targetUserId: string, token: string): Promise<void>
  lookupUserByEmail(email: string, token: string): Promise<AppUserLookup | null>
  createShareLink(resourceType: 'vault' | 'document', id: string, permission: string, token: string): Promise<AppShareLink>
  revokeShareLink(linkId: string, token: string): Promise<void>
  accessShareLink(shareToken: string): Promise<AppShareLinkAccess>
  openSharedDocument(shareToken: string, identity: IIdentityProvider): Promise<SharedDocumentHandle>
}

// ── Admin ─────────────────────────────────────────────────────────────────────

export interface AppAdminUser {
  id: string
  email: string
  displayName: string
  isAdmin: boolean
  createdAt: string
  lastLoginAt: string | null
  isLockedOut: boolean
}

export interface IAdminBackend {
  listUsers(token: string): Promise<AppAdminUser[]>
  createUser(token: string, email: string, password: string, displayName: string, isAdmin: boolean): Promise<void>
  resetPassword(token: string, userId: string, newPassword: string): Promise<void>
  revokeSessions(token: string, userId: string): Promise<void>
  disableUser(token: string, userId: string): Promise<void>
}

export interface IAdminAPI {
  listUsers(token: string): Promise<AppAdminUser[]>
  createUser(token: string, email: string, password: string, displayName: string, isAdmin: boolean): Promise<void>
  resetPassword(token: string, userId: string, newPassword: string): Promise<void>
  revokeSessions(token: string, userId: string): Promise<void>
  disableUser(token: string, userId: string): Promise<void>
}

// ── Application root ──────────────────────────────────────────────────────────

export interface IApplicationAPI {
  auth: IAuthAPI
  admin: IAdminAPI
  sharing: ISharingAPI
  vaults: IVaultsAPI
  documents: IDocumentsAPI
  documentSession: IDocumentSessionAPI
  workspace: IWorkspaceAPI
}
