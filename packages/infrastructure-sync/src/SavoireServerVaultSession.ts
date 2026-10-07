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
import type { DocumentRoomPresence, ICRDT, IIdentityProvider } from '@savoire/plugin-api'
import type { DocumentSyncKind, ISnapshotDocument, IVaultDirectory, IVaultFiles } from '@savoire/platform'
import type { IVaultSyncSession, VaultSyncSessionFactoryParams, IDocumentLocks, IVaultSharing } from '@savoire/application'
import type { IIndexChannel } from '@savoire/plugin-api'
import { YMapIndexChannel } from './YMapIndexChannel'
import { CollabOrchestrator } from '@savoire/application'
import { YMapVaultDirectory } from './YMapVaultDirectory'
import { YjsCrdtAdapter } from './YjsCrdtAdapter'
import { SignalRTransport } from './SignalRTransport'
import { VaultHubClient } from './VaultHubClient'
import { DocumentRoomClient, type JoinedDocumentRoom } from './DocumentRoomClient'
import { CrdtDocumentFetcher } from './CrdtDocumentFetcher'
import { RestVaultStorage } from './RestVaultStorage'
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
  readonly files: IVaultFiles
  /** Partage arbitre par le serveur (permissions et liens). */
  readonly sharing: IVaultSharing

  private constructor(
    private readonly opts: SavoireServerVaultSessionOptions,
    directory: IVaultDirectory,
    hub: VaultHubClient,
  ) {
    this.directory = directory
    this.hub = hub
    // Le repertoire est la source de verite du « la liste a change » : les
    // edits locaux comme les ops distantes appliquees par le hub y passent.
    this.unsubDirectory = directory.onChange(opts.onChanged)

    this.rooms = new DocumentRoomClient({ serverUrl: opts.serverUrl, getToken: opts.getToken })
    this.snapshots = new SnapshotDocuments((docId) =>
      roomChannel(this.rooms, opts.vaultId, docId, opts.userId))

    const storage = new RestVaultStorage({ baseUrl: opts.serverUrl })
    const token = (): string => opts.getToken() ?? opts.token
    this.files = {
      upload: (file) => storage.uploadAttachment(opts.vaultId, file, token()),
      url: (storagePath) => storage.resolveFileUrl(opts.vaultId, storagePath),
      read: (storagePath) => storage.readFile(opts.vaultId, storagePath, token()),
    }
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
    await hub.connect()
    return session
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
    this.fetcher ??= new CrdtDocumentFetcher({
      serverUrl: this.opts.serverUrl,
      getToken: this.opts.getToken,
      getUserId: () => this.opts.userId,
    })
    return this.fetcher.getDocumentContent(this.opts.vaultId, docId, '')
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
    void this.hub.joinIndex(namespace).then(ops => {
      for (const op of ops) channel.applyUpdate(op)
    })
    return channel
  }

  getState(): 'connected' | 'connecting' | 'disconnected' {
    // Le hub du vault porte le repertoire ; l'etat d'un document suit le sien.
    return this.hub.isConnected ? 'connected' : 'disconnected'
  }

  async dispose(): Promise<void> {
    this.unsubDirectory()
    for (const docId of [...this.docs.keys()]) this.closeDocument(docId)
    this.snapshots.dispose()
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
