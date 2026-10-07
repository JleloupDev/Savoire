// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Connecteur local : une session de vault SANS serveur. Les pairs echangent
// sur un bus (memoire ou BroadcastChannel) et chacun garde une replique de
// tout ce qu'il a entendu.
//
// Il sert de garde-fou au portage pair a pair. Ce qu'il n'a pas, un protocole
// P2P ne l'aura pas non plus :
//   - pas d'arbitre, donc pas de verrous (`locks` absent) ;
//   - pas de persistance : un pair qui arrive ne recoit que ce que les pairs
//     EN LIGNE savent ;
//   - pas d'identite signee.
// Si l'application fonctionne sur ce connecteur, elle ne depend du serveur que
// par ce que le port declare.
import * as Y from 'yjs'
import type { ICRDT, IIndexChannel, DocumentRoomPresence } from '@savoire/plugin-api'
import type { DocumentSyncKind, ISnapshotDocument, IVaultDirectory, IVaultFiles } from '@savoire/platform'
import type { IVaultSyncSession, IVaultSyncSessionFactory, VaultSyncSessionFactoryParams } from '@savoire/application'
import { YMapVaultDirectory } from './YMapVaultDirectory'
import { YjsCrdtAdapter } from './YjsCrdtAdapter'
import { YMapIndexChannel } from './YMapIndexChannel'
import { SnapshotDocuments, type SnapshotChannel } from './SnapshotDocuments'
import type { ILocalPeerBus, LocalPeerMessage, LocalPeerPayload, SnapshotStamp } from './LocalPeerBus'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const Y_ = Y as Record<string, any>

const REMOTE = 'remote'

export interface LocalPeerSessionOptions {
  /**
   * Temps laisse aux pairs pour repondre a une demande d'etat (ouverture d'un
   * document, lecture ponctuelle). Un pair qui repond plus tard est quand meme
   * pris en compte, mais apres.
   */
  settleMs?: number
}

interface StoredSnapshot {
  content: string
  stamp: SnapshotStamp
}

interface StoredFile {
  fileName: string
  type: string
  bytes: Uint8Array
  url?: string
}

function newer(a: SnapshotStamp, b: SnapshotStamp | undefined): boolean {
  if (!b) return true
  return a.clock !== b.clock ? a.clock > b.clock : a.peer > b.peer
}

const wait = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

export class LocalPeerVaultSession implements IVaultSyncSession {
  readonly directory: IVaultDirectory
  readonly files: IVaultFiles

  private readonly peerId = crypto.randomUUID()
  private readonly settleMs: number
  private readonly unsubBus: () => void
  private readonly unsubDirectory: () => void
  private readonly unsubDirectoryChange: () => void
  private disposed = false

  /** Replique de chaque document CRDT entendu, ouvert ou non. */
  private readonly replicas = new Map<string, ReturnType<typeof Y_.Doc>>()
  /** Documents ouverts dans un editeur. */
  private readonly openDocs = new Map<string, { crdt: YjsCrdtAdapter; unsubs: (() => void)[] }>()
  private readonly indexes = new Map<string, YMapIndexChannel>()
  private readonly indexListeners = new Map<string, (update: Uint8Array) => void>()
  private readonly snapshotStore = new Map<string, StoredSnapshot>()
  private readonly snapshotListeners = new Map<string, Set<(content: string, from: string) => void>>()
  private readonly presenceListeners = new Map<string, Set<(userId: string, p: DocumentRoomPresence) => void>>()
  private readonly snapshots: SnapshotDocuments
  private readonly fileStore = new Map<string, StoredFile>()
  private snapshotClock = 0

  constructor(
    private readonly bus: ILocalPeerBus,
    private readonly params: VaultSyncSessionFactoryParams,
    options: LocalPeerSessionOptions = {},
  ) {
    this.settleMs = options.settleMs ?? 150
    const directory = new YMapVaultDirectory()
    this.directory = directory
    this.unsubDirectory = directory.onLocalUpdate(update => this.send({ t: 'dir', update }))
    this.unsubDirectoryChange = directory.onChange(params.onChanged)
    this.snapshots = new SnapshotDocuments(docId => this.snapshotChannel(docId))
    this.files = {
      upload: file => this.uploadFile(file),
      url: storagePath => this.fileUrl(storagePath),
      read: async storagePath => {
        const file = this.fileStore.get(storagePath)
        if (!file) throw new Error(`fichier inconnu des pairs en ligne : ${storagePath}`)
        return new TextDecoder().decode(file.bytes)
      },
    }
    this.unsubBus = bus.subscribe(msg => this.receive(msg))
    this.send({ t: 'hello' })
    params.onConnectionChange?.('connected')
  }

  // ── Documents CRDT ─────────────────────────────────────────────────────────

  openDocument(docId: string): ICRDT {
    const existing = this.openDocs.get(docId)
    if (existing) return existing.crdt

    const crdt = new YjsCrdtAdapter()
    crdt.setLocalUser(this.params.userId)
    const replica = this.replica(docId)
    // Rendu vide, rempli juste apres : voir IVaultSyncSession.openDocument.
    queueMicrotask(() => {
      if (this.openDocs.get(docId)?.crdt === crdt) crdt.applyRemoteOp(Y_.encodeStateAsUpdate(replica))
    })
    const unsubs = [
      crdt.onLocalOp(update => {
        Y_.applyUpdate(replica, update, REMOTE)
        this.send({ t: 'doc', docId, update })
      }),
      crdt.onLocalPresenceChanged(bytes => this.send({ t: 'awareness', docId, bytes })),
    ]
    this.openDocs.set(docId, { crdt, unsubs })
    this.send({ t: 'doc-open', docId })
    return crdt
  }

  closeDocument(docId: string): void {
    const open = this.openDocs.get(docId)
    if (!open) return
    this.openDocs.delete(docId)
    for (const unsub of open.unsubs) unsub()
    open.crdt.dispose()
  }

  // ── Documents snapshot et lecture ponctuelle ───────────────────────────────

  openSnapshot(docId: string): ISnapshotDocument {
    return this.snapshots.open(docId)
  }

  closeSnapshot(docId: string): void {
    this.snapshots.close(docId)
  }

  async readDocument(docId: string, kind: DocumentSyncKind): Promise<string> {
    if (kind === 'snapshot') return this.snapshots.read(docId)
    if (!this.openDocs.has(docId)) {
      this.send({ t: 'doc-open', docId })
      await wait(this.settleMs)
    }
    return this.replica(docId).getText('codemirror').toString()
  }

  // ── Index ──────────────────────────────────────────────────────────────────

  openIndex(namespace: string): IIndexChannel {
    const existing = this.indexes.get(namespace)
    if (existing) return existing
    const channel = new YMapIndexChannel(namespace, {
      push: (ns, update) => this.send({ t: 'index', namespace: ns, update }),
      subscribe: (ns, cb) => {
        this.indexListeners.set(ns, cb)
        return () => { this.indexListeners.delete(ns) }
      },
    })
    this.indexes.set(namespace, channel)
    this.send({ t: 'index-open', namespace })
    return channel
  }

  getState(): 'connected' | 'connecting' | 'disconnected' {
    return this.disposed ? 'disconnected' : 'connected'
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    this.unsubBus()
    this.unsubDirectory()
    this.unsubDirectoryChange()
    for (const docId of [...this.openDocs.keys()]) this.closeDocument(docId)
    for (const channel of this.indexes.values()) channel.dispose()
    this.indexes.clear()
    this.snapshots.dispose()
    for (const file of this.fileStore.values()) if (file.url) URL.revokeObjectURL(file.url)
    this.directory.dispose()
  }

  // ── Reseau ─────────────────────────────────────────────────────────────────

  private send(payload: LocalPeerPayload, to?: string): void {
    if (this.disposed) return
    const msg = { ...payload, vaultId: this.params.vaultId, from: this.peerId, userId: this.params.userId } as LocalPeerMessage
    if (to) msg.to = to
    this.bus.post(msg)
  }

  private receive(msg: LocalPeerMessage): void {
    if (this.disposed) return
    if (msg.from === this.peerId || msg.vaultId !== this.params.vaultId) return
    if (msg.to && msg.to !== this.peerId) return

    switch (msg.t) {
      case 'hello':
        this.send({ t: 'dir', update: this.directory.encodeFullState() }, msg.from)
        for (const [storagePath, f] of this.fileStore) {
          this.send({ t: 'file', storagePath, fileName: f.fileName, type: f.type, bytes: f.bytes }, msg.from)
        }
        return
      case 'dir':
        this.directory.applyUpdate(msg.update)
        return
      case 'doc-open': {
        const replica = this.replicas.get(msg.docId)
        if (replica) this.send({ t: 'doc', docId: msg.docId, update: Y_.encodeStateAsUpdate(replica) }, msg.from)
        return
      }
      case 'doc':
        Y_.applyUpdate(this.replica(msg.docId), msg.update, REMOTE)
        this.openDocs.get(msg.docId)?.crdt.applyRemoteOp(msg.update)
        return
      case 'awareness':
        this.openDocs.get(msg.docId)?.crdt.applyRemotePresence(msg.bytes)
        return
      case 'index-open': {
        const channel = this.indexes.get(msg.namespace)
        if (channel) this.send({ t: 'index', namespace: msg.namespace, update: channel.encodeState() }, msg.from)
        return
      }
      case 'index':
        this.indexListeners.get(msg.namespace)?.(msg.update)
        return
      case 'snapshot-open': {
        const stored = this.snapshotStore.get(msg.docId)
        if (stored) this.send({ t: 'snapshot', docId: msg.docId, ...stored }, msg.from)
        return
      }
      case 'snapshot':
        this.receiveSnapshot(msg.docId, { content: msg.content, stamp: msg.stamp }, msg.userId)
        return
      case 'presence':
        for (const cb of this.presenceListeners.get(msg.docId) ?? []) cb(msg.userId, msg.presence)
        return
      case 'file':
        if (!this.fileStore.has(msg.storagePath)) {
          this.fileStore.set(msg.storagePath, { fileName: msg.fileName, type: msg.type, bytes: msg.bytes })
        }
        return
    }
  }

  private replica(docId: string): ReturnType<typeof Y_.Doc> {
    let doc = this.replicas.get(docId)
    if (!doc) {
      doc = new Y_.Doc()
      this.replicas.set(docId, doc)
    }
    return doc
  }

  // ── Snapshots ──────────────────────────────────────────────────────────────

  private receiveSnapshot(docId: string, incoming: StoredSnapshot, fromUserId: string): void {
    this.snapshotClock = Math.max(this.snapshotClock, incoming.stamp.clock)
    if (!newer(incoming.stamp, this.snapshotStore.get(docId)?.stamp)) return
    this.snapshotStore.set(docId, incoming)
    for (const cb of this.snapshotListeners.get(docId) ?? []) cb(incoming.content, fromUserId)
  }

  private snapshotChannel(docId: string): SnapshotChannel {
    const writes = new Set<(content: string, from: string) => void>()
    const presence = new Set<(userId: string, p: DocumentRoomPresence) => void>()
    this.snapshotListeners.set(docId, writes)
    this.presenceListeners.set(docId, presence)
    this.send({ t: 'snapshot-open', docId })
    return {
      initial: wait(this.settleMs).then(() => this.snapshotStore.get(docId)?.content ?? null),
      push: async (content) => {
        const stamp = { clock: ++this.snapshotClock, peer: this.peerId }
        this.snapshotStore.set(docId, { content, stamp })
        this.send({ t: 'snapshot', docId, content, stamp })
      },
      onRemote: (cb) => { writes.add(cb); return () => { writes.delete(cb) } },
      pushPresence: async (p) => { this.send({ t: 'presence', docId, presence: p }) },
      onPresence: (cb) => { presence.add(cb); return () => { presence.delete(cb) } },
      close: () => {
        this.snapshotListeners.delete(docId)
        this.presenceListeners.delete(docId)
      },
    }
  }

  // ── Fichiers ───────────────────────────────────────────────────────────────

  private async uploadFile(file: File): Promise<{ fileName: string; storagePath: string }> {
    const bytes = new Uint8Array(await file.arrayBuffer())
    const storagePath = `${crypto.randomUUID()}-${file.name}`
    const type = file.type || 'application/octet-stream'
    this.fileStore.set(storagePath, { fileName: file.name, type, bytes })
    this.send({ t: 'file', storagePath, fileName: file.name, type, bytes })
    return { fileName: file.name, storagePath }
  }

  private fileUrl(storagePath: string): string {
    const file = this.fileStore.get(storagePath)
    if (!file) return ''
    file.url ??= URL.createObjectURL(new Blob([file.bytes as BlobPart], { type: file.type }))
    return file.url
  }
}

/** Fabrique du connecteur local : toutes les sessions partagent le meme bus. */
export class LocalPeerVaultSessionFactory implements IVaultSyncSessionFactory {
  constructor(
    private readonly bus: ILocalPeerBus,
    private readonly options: LocalPeerSessionOptions = {},
  ) {}

  async open(params: VaultSyncSessionFactoryParams): Promise<IVaultSyncSession> {
    return new LocalPeerVaultSession(this.bus, params, this.options)
  }
}
