// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup

import type { DocumentStore, DocumentSyncKind, IDocumentMeta, IVaultContentSession, IVaultDirectory, VaultClient } from '@savoire/platform'
import type { ICRDT, ITransport, SyncAPI, VaultAPI, IIdentityProvider, IIndexChannel, ISharedText, ISharedTree } from '@savoire/plugin-api'

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
 *
 * Regle : toute donnee du vault passe par la session. Repertoire, documents
 * CRDT, documents snapshot, index, pieces jointes. Aucun appel reseau sur ces
 * donnees ailleurs. C'est ce qui garde le portage pair a pair possible.
 * Le contrat est verifie par une suite de tests commune (vaultSyncSessionContract)
 * qui tourne sur un connecteur local sans serveur.
 *
 * Les decisions qui demandent un arbitre (verrous) sont des capacites
 * OPTIONNELLES : un profil sans arbitre ne les fournit pas, et l'application
 * doit fonctionner sans.
 */
export interface IVaultSyncSession extends IVaultContentSession {
  /** Liste des notes du vault, creee et synchronisee par la session. */
  readonly directory: IVaultDirectory
  /** Ouvre (ou reprend) la synchro d'un document et rend son CRDT.
   *  Idempotent : deux appels pour le meme docId rendent le meme objet.
   *
   *  Le CRDT est rendu VIDE ; son etat arrive ensuite, comme des mises a jour
   *  distantes, meme s'il est deja connu localement. L'editeur se monte sur un
   *  texte vide et ne suit que les changements posterieurs (yCollab) : un etat
   *  present des le retour de cette methode resterait invisible. */
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
  /**
   * Reglages partages du vault, par section (« plugins »...) : une carte CRDT
   * cle -> valeur, synchronisee entre tous les membres. Deux membres qui
   * changent deux cles differentes ne s'ecrasent pas ; sur la meme cle, le
   * dernier gagne. Idempotent.
   */
  openVaultSettings(section: string): IIndexChannel
  /**
   * Carte partagee du vault, cle -> valeur, par nom (« review »...). Meme
   * mecanique que les reglages : un CRDT synchronise entre les membres.
   * Idempotent. Brique de la couche de revision, et demain de l'API CRDT
   * des plugins.
   */
  openSharedMap(name: string): IIndexChannel
  /**
   * Ajoute du texte a la fin d'un document CRDT OUVERT (openDocument), comme
   * une frappe : l'editeur l'affiche, les pairs le recoivent. Echoue si le
   * document n'est pas ouvert : son etat n'est peut-etre pas encore arrive,
   * et le texte risquerait de se placer avant le contenu existant.
   */
  appendText(docId: string, text: string): void
  /**
   * Le texte d'un document CRDT OUVERT (openDocument), pour un plugin : le
   * contrat ISharedText, sans bibliotheque CRDT visible. Meme texte que
   * l'editeur. Idempotent ; devient inerte a la fermeture du document.
   * Echoue si le document n'est pas ouvert, comme appendText.
   *
   * Meme regle qu'openDocument : le texte est vide a l'ouverture et l'etat
   * connu arrive ensuite en deltas d'origine 'remote'. Un plugin qui ouvre
   * le texte plus tard lit toString() puis suit les deltas.
   */
  openText(docId: string): ISharedText
  /**
   * Le meme document CRDT OUVERT, vu comme un arbre JSON (ISharedTree) :
   * cartes, listes, textes riches, elements. Racine separee du texte.
   * Memes regles qu'openText : idempotent, echoue si le document n'est pas
   * ouvert, racine vide a l'ouverture et etat connu en lot 'remote' ensuite.
   */
  openTree(docId: string): ISharedTree
  /**
   * Etat COMPLET d'un document CRDT, ouvert ou non, une fois recu (pairs,
   * serveur, disque) : tout l'historique fusionnable, pas seulement le texte.
   * Octets opaques, dans le format du protocole de la session ; deux sessions
   * qui parlent le meme protocole se les echangent (copie d'un vault). Un
   * document jamais ecrit rend un etat vide (fusionnable aussi).
   */
  readDocumentState(docId: string): Promise<Uint8Array>
  /**
   * Fusionne un etat (rendu par readDocumentState, ici ou dans une autre
   * session) dans un document CRDT, comme une modification locale : persiste
   * et diffuse aux pairs, et l'editeur ouvert le recoit. Idempotent : fusionner
   * deux fois le meme etat ne change rien. Rejette si l'etat n'a pas pu
   * partir : jamais de perte silencieuse.
   */
  mergeDocumentState(docId: string, state: Uint8Array): Promise<void>
  /**
   * Attend que les modifications locales (repertoire, cartes partagees) soient
   * parties. Rejette si une n'a pas pu partir et n'a pas pu etre renvoyee.
   * Sans reseau ni ecriture differee, rend tout de suite.
   */
  flush(): Promise<void>
  /**
   * Verrous d'edition, pour les types de documents qui ne sont pas des CRDT.
   * Absent d'un profil qui n'a pas d'arbitre : sans arbitrage central, deux
   * pairs ne peuvent pas trancher qui detient le verrou, et pretendre le
   * contraire serait pire que ne rien offrir.
   */
  readonly locks?: IDocumentLocks
  /**
   * Partage du vault et de ses documents : qui y a acces, avec quel droit.
   * Capacite d'arbitrage, comme les verrous : le profil serveur la fournit,
   * un profil sans arbitre ne la fournit pas, et l'UI masque alors le partage.
   * Un protocole P2P la portera par son ACL (les liens publics, eux, supposent
   * un serveur qui les sert).
   */
  readonly sharing?: IVaultSharing
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

/** Detenteur courant d'un verrou d'edition. */
export interface DocumentLockState {
  holderUserId: string
  holderDisplayName: string
  /** true = c'est nous. L'editeur reste alors modifiable. */
  isHeldByCaller: boolean
}

export interface IDocumentLocks {
  /** Prend le verrou s'il est libre. Rend le detenteur EFFECTIF, qui peut etre un autre. */
  acquire(docId: string): Promise<DocumentLockState | null>
  /** Etat courant, sans rien prendre. */
  get(docId: string): Promise<DocumentLockState | null>
  release(docId: string): Promise<void>
  /** Demande la main au detenteur. Il decide : on ne prend pas d'autorite. */
  request(docId: string): Promise<void>
  /** Le verrou d'un document a change de main (ou a ete libere). */
  onChanged(cb: (docId: string, holder: DocumentLockState | null) => void): () => void
  /** Quelqu'un demande la main sur un document que NOUS detenons. */
  onRequested(cb: (docId: string, requesterName: string) => void): () => void
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
  /**
   * Le vault n'existe plus, ou on n'y a plus acces (supprime par son
   * proprietaire, acces retire). Ce n'est pas une coupure : la session a deja
   * arrete ses reessais et ses reconnexions. Appele une seule fois, apres
   * l'ouverture ; l'appelant ferme la session (dispose) et previent la
   * personne. Si le vault est deja perdu a l'ouverture, open() rejette avec
   * VaultGoneError a la place.
   *
   * Optionnel et agnostique : un profil qui ne sait pas le detecter ne
   * l'appelle jamais (le profil local pourra le faire a la revocation).
   */
  onVaultGone?: () => void
}

/**
 * Le vault n'existe plus, ou on n'y a plus acces. Rendue par open() d'une
 * session, ou par un appel fait apres la perte du vault. Distincte d'une
 * erreur reseau : reessayer ne sert a rien.
 */
export class VaultGoneError extends Error {
  constructor(readonly vaultId: string) {
    super(`Le vault ${vaultId} n'existe plus ou vous n'y avez plus acces.`)
    this.name = 'VaultGoneError'
  }
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
  documentStore: DocumentStore
  /**
   * Famille de synchro d'un document (CRDT ou snapshot), d'apres le type
   * declare par son plugin. Defaut : seul le Markdown est un CRDT.
   */
  syncKindOf?: (path: string) => DocumentSyncKind
  resolveDoc: (path: string) => IDocumentMeta | undefined
  onChanged: () => void
  /** Graine Ed25519, transmise telle quelle a la fabrique de session. */
  identitySeed?: Uint8Array
  identity?: IIdentityProvider
  onConnectionChange?: (state: 'connected' | 'disconnected') => void
  /** Transmis tel quel a la fabrique : voir VaultSyncSessionFactoryParams.onVaultGone. */
  onVaultGone?: () => void
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
  /**
   * Images rangees dans le dossier de la note partagee (les seules que le
   * lien peut lire). Absent si le vault de la note est inconnu.
   */
  attachments?: { url(target: string): Promise<string>; dispose(): void }
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

/** La part du partage qui depend du profil de synchro. Voir IVaultSyncSession.sharing. */
export type IVaultSharing = Pick<ISharingAPI,
  'getSharing' | 'grantPermission' | 'revokePermission' | 'lookupUserByEmail' | 'createShareLink' | 'revokeShareLink'>

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
