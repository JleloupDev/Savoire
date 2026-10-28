// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Profil serveur Savoire : le serveur relaie et persiste les ops en clair.
// Implemente IVaultSyncSession, exactement comme le connecteur EdgeSync et
// comme le ferait un futur connecteur automerge-repo/Beelay.
//
// C'est ici que vivent les `new` qui etaient jusqu'ici codes en dur dans
// apps/web : YMapVaultDirectory, YjsCrdtAdapter, SignalRTransport. Changer de
// protocole se fait en changeant de fabrique de session, sans toucher l'app.
//
// Tous les chemins reseau du contenu du vault partent d'ici : hub du vault,
// hub des documents CRDT, rooms des documents snapshot, REST des pieces jointes.
import type { DocumentRoomPresence, ICRDT, IIdentityProvider, ISharedText, ISharedTree } from '@savoire/plugin-api'
import type { DocumentSyncKind, ISnapshotDocument, IVaultDirectory } from '@savoire/platform'
import type { IVaultSyncSession, VaultSyncSessionFactoryParams, IDocumentLocks, IVaultSharing } from '@savoire/application'
import type { IIndexChannel } from '@savoire/plugin-api'
import { encodeSignedOp } from '@savoire/plugin-api'
import * as Y from 'yjs'
import { YMapIndexChannel } from './YMapIndexChannel'
import { bytesToBase64 } from './base64'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const Y_ = Y as Record<string, any>

/** Taille maximale d'un message recu par un hub SignalR, par defaut (32 Kio). */
const SIGNALR_DEFAULT_MAX_MESSAGE = 32 * 1024
import { CollabOrchestrator, VaultGoneError } from '@savoire/application'
import { VaultGoneSignal } from './vaultGone'
import { YMapVaultDirectory } from './YMapVaultDirectory'
import { YjsCrdtAdapter } from './YjsCrdtAdapter'
import { SignalRTransport } from './SignalRTransport'
import { VaultHubClient, INDEX_COMPACT_THRESHOLD } from './VaultHubClient'
import { DocumentRoomClient, type JoinedDocumentRoom } from './DocumentRoomClient'
import { CrdtDocumentFetcher } from './CrdtDocumentFetcher'
import { RestVaultStorage } from './RestVaultStorage'
import { ServerVaultFiles } from './ServerVaultFiles'
import { HttpSharingBackend } from './HttpSharingBackend'
import { SnapshotDocuments, type SnapshotChannel } from './SnapshotDocuments'

interface OpenDoc {
  crdt: YjsCrdtAdapter
  transport: SignalRTransport
  orchestrator: CollabOrchestrator
}

export interface SavoireServerVaultSessionOptions extends VaultSyncSessionFactoryParams {
  serverUrl?: string
  getToken: () => string | null
}

export class SavoireServerVaultSession implements IVaultSyncSession {
  readonly directory: IVaultDirectory
  private readonly docs = new Map<string, OpenDoc>()
  private readonly indexes = new Map<string, YMapIndexChannel>()
  private readonly hub: VaultHubClient
  private readonly unsubDirectory: () => void
  private readonly rooms: DocumentRoomClient
  private readonly snapshots: SnapshotDocuments
  /** Lecture ponctuelle des documents CRDT non ouverts. Cree a la premiere lecture. */
  private fetcher: CrdtDocumentFetcher | undefined
  readonly files: ServerVaultFiles
  /** Partage arbitre par le serveur (permissions et liens). */
  readonly sharing: IVaultSharing
  /** Allume au premier « vault-not-found » d'un hub : tout le reseau du vault s'arrete. */
  private readonly gone: VaultGoneSignal
  /** Vrai une fois open() termine : avant, la perte du vault fait rejeter open(). */
  private opened = false
  private disposed = false

  private constructor(
    private readonly opts: SavoireServerVaultSessionOptions,
    directory: IVaultDirectory,
    hub: VaultHubClient,
  ) {
    this.directory = directory
    this.hub = hub
    this.gone = hub.gone
    this.gone.onGone(() => this.onGone())
    // Le repertoire est la source de verite du « la liste a change » : les
    // edits locaux comme les ops distantes appliquees par le hub y passent.
    this.unsubDirectory = directory.onChange(opts.onChanged)

    this.rooms = new DocumentRoomClient({ serverUrl: opts.serverUrl, getToken: opts.getToken, gone: this.gone })
    this.snapshots = new SnapshotDocuments((docId) =>
      roomChannel(this.rooms, opts.vaultId, docId, opts.userId))

    const storage = new RestVaultStorage({ baseUrl: opts.serverUrl })
    const token = (): string => opts.getToken() ?? opts.token
    this.files = new ServerVaultFiles(storage, opts.vaultId, token)
    this.sharing = new HttpSharingBackend(opts.serverUrl ?? '')
  }

  static async open(opts: SavoireServerVaultSessionOptions): Promise<SavoireServerVaultSession> {
    const directory = new YMapVaultDirectory()
    const hub = new VaultHubClient(
      opts.serverUrl ?? '',
      opts.vaultId,
      directory,
      opts.onChanged,
      opts.getToken,
      opts.onConnectionChange,
    )
    const session = new SavoireServerVaultSession(opts, directory, hub)
    // Envois perdus pendant une coupure : renvoyer l'etat complet des la
    // reconnexion, sans attendre la fermeture du vault.
    hub.onReconnected(() => { void session.flush().catch(() => {}) })
    await hub.connect()
    if (hub.gone.gone) return session.rejectOpen()
    // Documents deja dans le repertoire mais pas encore inscrits (crees avant
    // le registre) : les inscrire maintenant, avant toute ouverture. Exige le
    // droit d'ecrire : chez un lecteur, l'echec est attendu et sans effet.
    const known = directory.getAll().map(d => d.id)
    if (known.length > 0) {
      await session.registerDocuments(known).catch(err =>
        { if (!(err instanceof VaultGoneError)) console.warn('[SavoireServerVaultSession] inscription des documents existants refusee', err) })
    }
    if (hub.gone.gone) return session.rejectOpen()
    session.opened = true
    return session
  }

  /** Vault perdu des l'ouverture : rien a fermer cote app, open() rejette. */
  private async rejectOpen(): Promise<never> {
    await this.dispose()
    throw new VaultGoneError(this.opts.vaultId)
  }

  /** Vault perdu : arreter les documents ouverts, puis prevenir l'app une fois. */
  private onGone(): void {
    for (const open of this.docs.values()) void open.transport.disconnect().catch(() => {})
    // Fermee entre-temps (changement de vault) : plus personne a prevenir.
    if (this.opened && !this.disposed) this.opts.onVaultGone?.()
  }

  openDocument(docId: string): ICRDT {
    const existing = this.docs.get(docId)
    if (existing) return existing.crdt

    const identity: IIdentityProvider | undefined = this.opts.identity
    if (!identity) throw new Error('SavoireServerVaultSession requires an identity provider to sign ops')

    const crdt = new YjsCrdtAdapter()
    const transport = new SignalRTransport({
      serverUrl: this.opts.serverUrl ?? '',
      userId: this.opts.userId,
      getToken: this.opts.getToken,
      gone: this.gone,
    })
    const orchestrator = new CollabOrchestrator(crdt, transport, identity)
    this.docs.set(docId, { crdt, transport, orchestrator })
    void transport.join(this.opts.vaultId, docId)
    return crdt
  }

  closeDocument(docId: string): void {
    const open = this.docs.get(docId)
    if (!open) return
    this.docs.delete(docId)
    open.orchestrator.dispose()
    void open.transport.disconnect()
    open.crdt.dispose()
  }

  async registerDocuments(docIds: string[]): Promise<void> {
    if (docIds.length === 0) return
    const rejected = await this.hub.registerDocuments(docIds)
    if (rejected.length > 0) throw new Error(`documents deja inscrits dans un autre vault : ${rejected.join(', ')}`)
  }

  openSnapshot(docId: string): ISnapshotDocument {
    return this.snapshots.open(docId)
  }

  closeSnapshot(docId: string): void {
    this.snapshots.close(docId)
  }

  async readDocument(docId: string, kind: DocumentSyncKind): Promise<string> {
    if (kind === 'snapshot') return this.snapshots.read(docId)
    // Document ouvert dans un editeur : son etat local est le plus frais.
    const open = this.docs.get(docId)
    if (open) return (open.crdt.rawDoc as { getText(name: string): { toString(): string } }).getText('codemirror').toString()
    if (this.gone.gone) throw new VaultGoneError(this.opts.vaultId)
    try {
      return await this.documentFetcher().getDocumentContent(this.opts.vaultId, docId, '')
    } catch (err) {
      if (this.gone.check(err)) throw new VaultGoneError(this.opts.vaultId)
      throw err
    }
  }

  /** Connexion de lecture/ecriture ponctuelle des documents CRDT (hors editeur). */
  private documentFetcher(): CrdtDocumentFetcher {
    this.fetcher ??= new CrdtDocumentFetcher({
      serverUrl: this.opts.serverUrl,
      getToken: this.opts.getToken,
      getUserId: () => this.opts.userId,
    })
    return this.fetcher
  }

  async readDocumentState(docId: string): Promise<Uint8Array> {
    if (this.gone.gone) throw new VaultGoneError(this.opts.vaultId)
    try {
      // L'etat persiste par le serveur, plus celui d'un editeur ouvert (le
      // plus frais) : la fusion des deux ne perd rien.
      const stored = await this.documentFetcher().getDocumentState(this.opts.vaultId, docId)
      const open = this.docs.get(docId)
      return open ? (Y_.mergeUpdates([stored, open.crdt.getSnapshot()]) as Uint8Array) : stored
    } catch (err) {
      if (this.gone.check(err)) throw new VaultGoneError(this.opts.vaultId)
      throw err
    }
  }

  /**
   * Pousse l'etat comme une op signee, par la connexion ponctuelle : un echec
   * remonte (le transport d'un editeur, lui, se tait hors ligne). Un editeur
   * ouvert sur ce document la recoit du serveur comme une op distante.
   */
  async mergeDocumentState(docId: string, state: Uint8Array): Promise<void> {
    if (this.gone.gone) throw new VaultGoneError(this.opts.vaultId)
    const identity = this.opts.identity
    if (!identity) throw new Error('SavoireServerVaultSession requires an identity provider to sign ops')
    const signed = encodeSignedOp(state, await identity.sign(state), identity.getPublicKey())
    const message = bytesToBase64(signed)
    try {
      await this.documentFetcher().pushOperation(this.opts.vaultId, docId, this.opts.userId, message)
    } catch (err) {
      if (this.gone.check(err)) throw new VaultGoneError(this.opts.vaultId)
      // Le hub refuse les messages de plus de 32 Kio (reglage par defaut de
      // SignalR cote serveur) : le dire, plutot qu'une coupure sans raison.
      if (message.length > SIGNALR_DEFAULT_MAX_MESSAGE) {
        throw new Error(`document trop gros pour un message du serveur (${Math.round(message.length / 1024)} Kio, limite 32 Kio) : ${err instanceof Error ? err.message : String(err)}`)
      }
      throw err
    }
  }

  /**
   * Attend les envois du hub. Si certains se sont perdus (coupure, refus),
   * renvoie l'etat complet du repertoire et des cartes ouvertes : une fusion
   * CRDT, sans doublon. Rejette si ce renvoi echoue aussi.
   */
  async flush(): Promise<void> {
    const lost = await this.hub.settle()
    if (lost === 0) return
    await this.hub.pushVaultStateOrThrow(this.directory.encodeFullState())
    for (const [namespace, channel] of this.indexes) {
      await this.hub.pushIndexStateOrThrow(namespace, channel.encodeState())
    }
    this.hub.acknowledgeLost(lost)
  }

  /** Arbitrage des verrous : delegue au hub, seul point central du profil. */
  get locks(): IDocumentLocks {
    return {
      acquire: (docId) => this.hub.acquireLock(docId),
      get: (docId) => this.hub.getLock(docId),
      release: (docId) => this.hub.releaseLock(docId),
      request: (docId) => this.hub.requestLock(docId),
      onChanged: (cb) => this.hub.onLockChanged(cb),
      onRequested: (cb) => this.hub.onLockRequested(cb),
    }
  }

  openIndex(namespace: string): IIndexChannel {
    const existing = this.indexes.get(namespace)
    if (existing) return existing
    // Le hub relaie les mises a jour en binaire opaque, exactement comme le
    // repertoire de vault et les documents : le serveur ne lit rien.
    const channel = new YMapIndexChannel(namespace, {
      push: (ns, update) => void this.hub.pushIndexUpdate(ns, update),
      subscribe: (ns, cb) => this.hub.onIndexUpdate(ns, cb),
    })
    this.indexes.set(namespace, channel)
    channel.markLoaded(this.hub.joinIndex(namespace).then(ops => {
      for (const op of ops) channel.applyUpdate(op)
      // Journal trop long : le remplacer par l'etat compacte, comme le
      // repertoire du vault et les documents. Le serveur ne remplace que les
      // trames rejouees ici ; celles arrivees entre-temps restent.
      if (ops.length > INDEX_COMPACT_THRESHOLD && !this.disposed && this.indexes.get(namespace) === channel)
        void this.hub.snapshotIndex(namespace, channel.encodeState())
    }))
    return channel
  }

  /** Meme mecanisme qu'un index, sous un prefixe reserve : le hub relaie sans lire. */
  openVaultSettings(section: string): IIndexChannel {
    return this.openIndex(`settings/${section}`)
  }

  openSharedMap(name: string): IIndexChannel {
    return this.openIndex(`map/${name}`)
  }

  appendText(docId: string, text: string): void {
    const open = this.docs.get(docId)
    if (!open) throw new Error(`appendText : le document ${docId} n'est pas ouvert`)
    const ytext = (open.crdt.rawDoc as { getText(name: string): { length: number; insert(i: number, t: string): void } }).getText('codemirror')
    ytext.insert(ytext.length, text)
  }

  openText(docId: string): ISharedText {
    const open = this.docs.get(docId)
    if (!open) throw new Error(`openText : le document ${docId} n'est pas ouvert`)
    return open.crdt.sharedText()
  }

  openTree(docId: string): ISharedTree {
    const open = this.docs.get(docId)
    if (!open) throw new Error(`openTree : le document ${docId} n'est pas ouvert`)
    return open.crdt.sharedTree()
  }

  getState(): 'connected' | 'connecting' | 'disconnected' {
    // Le hub du vault porte le repertoire ; l'etat d'un document suit le sien.
    return this.hub.isConnected && !this.gone.gone ? 'connected' : 'disconnected'
  }

  async dispose(): Promise<void> {
    this.disposed = true
    this.unsubDirectory()
    for (const docId of [...this.docs.keys()]) this.closeDocument(docId)
    this.snapshots.dispose()
    this.files.dispose()
    await this.fetcher?.dispose()
    for (const channel of this.indexes.values()) channel.dispose()
    this.indexes.clear()
    await this.hub.dispose()
    this.directory.dispose()
  }
}

/** Canal snapshot du profil serveur : une room SignalR, persistee par le hub. */
function roomChannel(
  rooms: DocumentRoomClient,
  vaultId: string,
  docId: string,
  userId: string,
): SnapshotChannel {
  const room = rooms.openRoom(vaultId, docId, userId)
  const writeListeners = new Set<(content: string, fromUserId: string) => void>()
  const presenceListeners = new Set<(userId: string, presence: DocumentRoomPresence) => void>()
  let closed = false
  let joined: JoinedDocumentRoom | undefined

  room.then((r) => {
    joined = r
    if (closed) return
    r.onSnapshot((content, from) => { for (const cb of writeListeners) cb(content, from) })
    r.onPresence((user, presence) => { for (const cb of presenceListeners) cb(user, presence) })
  }, () => { /* hub injoignable : le document reste vide, l'echec se voit a l'ecriture */ })

  return {
    initial: room.then(r => r.initialSnapshot),
    push: async (content) => { await (await room).pushSnapshot(content) },
    onRemote: (cb) => { writeListeners.add(cb); return () => { writeListeners.delete(cb) } },
    pushPresence: async (presence) => { await (await room).updatePresence(presence) },
    onPresence: (cb) => { presenceListeners.add(cb); return () => { presenceListeners.delete(cb) } },
    close: () => {
      closed = true
      writeListeners.clear()
      presenceListeners.clear()
      // Fermeture SYNCHRONE si la room est rejointe : une reouverture juste
      // apres (lecture ponctuelle puis vue) doit trouver la place libre.
      if (joined) void joined.close()
      else void room.then(r => r.close(), () => {})
    },
  }
}
