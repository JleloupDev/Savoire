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
  /** S2, decided once at creation: true if the server holds this vault's
   *  Keyring directly (ManagedVaultKeyringSource) — no K_User ever needed to
   *  open it. False = self-managed (S3, VaultKeyEscrow, per-account K_User). */
  isManaged: boolean
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
  /** Pushes an index op to the server. Returns the assigned seq, or null if offline. */
  pushIndexOp?(docId: string, path: string, markdownContent: string): Promise<number | null>
  /** Subscribes to index ops received from other clients. */
  onIndexOpApplied?(cb: (evt: { seq: number; docId: string; path: string; markdownContent: string }) => void): () => void
  /** Push a binary vault CRDT update to the server (for relay to other peers). */
  pushVaultUpdate?(update: Uint8Array): Promise<void>
}

export interface VaultHubFactoryParams {
  vaultId: string
  vaultClient: VaultClient
  onChanged: () => void
}

export interface IVaultHubFactory {
  create(params: VaultHubFactoryParams): VaultHubLike
}

/**
 * Abstract shape of EdgesyncVaultSession (@savoire/infrastructure-sync) — kept
 * structural here (not imported) because infrastructure-sync depends on
 * @savoire/application, so importing it back would create a cycle. Vault +
 * documents share one E2E-encrypted edgesync Keyring; the server never reads
 * either (it only relays opaque frames / signals WebRTC negotiation).
 */
/** Structural subset of @savoire/plugin-api's ICRDT presence methods —
 *  satisfied today by YjsCrdtAdapter. Kept structural for the same
 *  cycle-avoidance reason as EdgesyncVaultSessionLike itself. */
export interface CrdtPresenceLike {
  onLocalPresenceChanged(cb: (bytes: Uint8Array, changedClients: number[]) => void): () => void
  applyRemotePresence(bytes: Uint8Array): void
}

export interface EdgesyncVaultSessionLike {
  /** Fixed forever: was this peer the one whose genesis minted the vault. */
  readonly isOwner: boolean
  /** Dynamic: true once this peer actually possesses K_vault (may become true
   *  for a non-owner too, once granted — see EdgesyncVaultSession). */
  readonly isGranting: boolean
  /** Start (or resume) live E2E-encrypted sync for one currently-open
   *  document's Y.Doc. `presence`, if given, also wires peer cursors
   *  (y-protocols/awareness) over the same channel — see
   *  EdgesyncAwarenessChannel. */
  openDocument(docId: string, doc: unknown, presence?: CrdtPresenceLike): void
  /** Stop syncing a document whose editor panel closed. */
  closeDocument(docId: string): void
  /** Awaited by disposeActiveVault(): must fully close before a caller
   *  switching to a different vault proceeds (see EdgesyncVaultSession). */
  dispose(): Promise<void>
}

export interface EdgesyncVaultSessionFactoryParams {
  vaultId: string
  /** 32-byte Ed25519 seed (e.g. an ISeedExportingIdentityProvider's exportSignSeed()). */
  identitySeed: Uint8Array
  directory: IVaultDirectory
  /** S2 vs S3 — see AppVaultSummary.isManaged. Determines which KeyringSource
   *  the factory constructs (ManagedVaultKeyringSource vs VaultKeyEscrow). */
  isManaged: boolean
}

export interface IEdgesyncVaultSessionFactory {
  open(params: EdgesyncVaultSessionFactoryParams): Promise<EdgesyncVaultSessionLike>
}

export interface IVaultsBackend {
  listVaults(userId: string, token: string): Promise<AppWorkspace>
  createVault(userId: string, name: string, token: string, isManaged: boolean): Promise<AppVaultSummary>
  renameVault(vaultId: string, name: string, token: string): Promise<AppVaultSummary>
  deleteVault(vaultId: string, token: string): Promise<void>
}

export interface IVaultsAPI {
  list(userId: string, token: string): Promise<AppWorkspace>
  create(userId: string, name: string, token: string, isManaged: boolean): Promise<AppVaultSummary>
  rename(vaultId: string, name: string, token: string): Promise<AppVaultSummary>
  delete(vaultId: string, token: string): Promise<void>
}

export interface ActivatedVault {
  readonly vaultId: string
  readonly client: VaultClient
  readonly hub: VaultHubLike
  readonly edgesyncVault?: EdgesyncVaultSessionLike
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
  /** 32-byte Ed25519 seed for the vault's shared edgesync Keyring. */
  identitySeed: Uint8Array
  /** S2 vs S3 — see AppVaultSummary.isManaged. Threaded through to
   *  IEdgesyncVaultSessionFactory.open(). */
  isManaged: boolean
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
  getActiveEdgesyncVault(): EdgesyncVaultSessionLike | undefined
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
