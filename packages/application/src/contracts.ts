// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup

import type { DocumentStore, IDocumentMeta, IVaultDirectory, IVaultStorage, VaultClient } from '@savoire/platform'
import type { ICRDT, ITransport, SyncAPI, VaultAPI, IIdentityProvider, IIndexChannel } from '@savoire/plugin-api'

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

/** Sous-ensemble structurel des methodes de presence d'ICRDT (@savoire/plugin-api),
 *  satisfait par YjsCrdtAdapter. Garde structurel pour eviter un cycle de
 *  dependances (infrastructure-sync depend deja de @savoire/application). */
export interface CrdtPresenceLike {
  onLocalPresenceChanged(cb: (bytes: Uint8Array, changedClients: number[]) => void): () => void
  applyRemotePresence(bytes: Uint8Array): void
}

/**
 * Session de synchronisation d'un vault. UN port, deux implementations
 * aujourd'hui (profil serveur Savoire, profil EdgeSync), ouvert a une
 * troisieme (automerge-repo + Beelay/Keyhive).
 *
 * La session POSSEDE le cycle de vie du repertoire et des documents : c'est
 * elle qui les cree. C'est deliberement l'inverse du sens naturel, et c'est ce
 * qui rend le port portable : automerge-repo possede le document, sa
 * persistance et sa synchro dans un `Repo`, donc l'application ne peut pas
 * fabriquer l'objet CRDT puis le confier au transport. Un port qui ferait
 * `openDocument(docId, doc)` exclurait Automerge par construction.
 *
 * Corollaire : aucun `new YjsCrdtAdapter()` ni `new YMapVaultDirectory()` dans
 * l'application. Changer de protocole = changer de fabrique, rien d'autre.
 */
export interface IVaultSyncSession {
  /** Liste des notes du vault, creee et synchronisee par la session. */
  readonly directory: IVaultDirectory
  /** Ouvre (ou reprend) la synchro d'un document et rend son CRDT.
   *  Idempotent : deux appels pour le meme docId rendent le meme objet. */
  openDocument(docId: string): ICRDT
  /** Arrete la synchro d'un document dont le panneau s'est ferme. */
  closeDocument(docId: string): void
  getState(): 'connected' | 'connecting' | 'disconnected'
  /**
   * Ouvre (ou reprend) le canal partage d'un namespace d'index. Un canal par
   * namespace : un client ne synchronise que les index dont ses plugins
   * charges ont besoin. Idempotent — deux appels rendent le meme canal.
   *
   * Le serveur n'est qu'un passe-plat : il relaie des trames opaques, comme
   * pour les documents, et ne stocke aucun etat d'index interpretable.
   */
  openIndex(namespace: string): IIndexChannel
  dispose(): Promise<void>
}

/**
 * Extras d'un protocole a cles (EdgeSync aujourd'hui, Keyhive demain). Le
 * profil serveur Savoire n'en a aucun : a detecter structurellement via
 * isKeyManagedSession(), jamais a supposer.
 */
export interface IKeyManagedVaultSession {
  /** Fixe : ce pair est-il celui dont la genese a cree le vault. */
  readonly isOwner: boolean
  /** Dynamique : ce pair possede-t-il la cle du vault. */
  readonly isGranting: boolean
  /** Rotation de la cle du vault vers une nouvelle epoque. */
  renewVaultKey(): Promise<void>
  debugVaultKey(): { epoch: number; base64: string } | undefined
  debugDocKey(docId: string): string | undefined
}

export function isKeyManagedSession(
  session: IVaultSyncSession,
): session is IVaultSyncSession & IKeyManagedVaultSession {
  return typeof (session as Partial<IKeyManagedVaultSession>).renewVaultKey === 'function'
}

export interface VaultSyncSessionFactoryParams {
  vaultId: string
  token: string
  userId: string
  /** Graine Ed25519 32 octets, requise par les profils a identite (EdgeSync). */
  identitySeed?: Uint8Array
  /** Signe les ops sortantes (profil serveur, via CollabOrchestrator). */
  identity?: IIdentityProvider
  /** Appele quand la liste des notes change, quelle qu'en soit l'origine. */
  onChanged: () => void
  /** Remonte l'etat de connexion du transport a l'UI. */
  onConnectionChange?: (state: 'connected' | 'disconnected') => void
}

export interface IVaultSyncSessionFactory {
  open(params: VaultSyncSessionFactoryParams): Promise<IVaultSyncSession>
}

export interface IVaultsBackend {
  listVaults(userId: string, token: string): Promise<AppWorkspace>
  createVault(userId: string, name: string, token: string): Promise<AppVaultSummary>
  renameVault(vaultId: string, name: string, token: string): Promise<AppVaultSummary>
  deleteVault(vaultId: string, token: string): Promise<void>
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
  /** Absente pour un document partage isole (activateSharedDocument). */
  readonly session?: IVaultSyncSession
  dispose(): Promise<void>
}

export interface ActivateVaultParams {
  vaultId: string
  token: string
  userId: string
  storage: IVaultStorage
  documentStore: DocumentStore
  resolveDoc: (path: string) => IDocumentMeta | undefined
  onChanged: () => void
  /** Graine Ed25519, transmise telle quelle a la fabrique de session. */
  identitySeed?: Uint8Array
  identity?: IIdentityProvider
  onConnectionChange?: (state: 'connected' | 'disconnected') => void
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
  getActiveSession(): IVaultSyncSession | undefined
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
