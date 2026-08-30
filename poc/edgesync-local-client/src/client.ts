// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Composition root of the local P2P vault client (spec: docs/Architecture/
// edgesync-local-client-v0-spec.md). Wires identity + a shared Keyring +
// a shared PeerStore + local persistence (FileSystemStorage) + one
// WebSocketTransport + a vault-directory Session (§4.4's grant anchor) + one
// Session per document, and exposes the local editing API (§6.1).
//
// Ownership rule (§3.1, simplified for a point-to-point transport with no
// room/discovery server): whoever LISTENS is the one an empty vault's genesis
// binds to (S1: "A démarre en écoute [...] A devient owner"); whoever DIALS
// into it is the joiner. This only applies the FIRST time a vault is ever
// opened (no keyring on disk yet) — on every later restart the persisted
// keyring is reused as-is, and `isGranting` is recomputed from actual K_vault
// possession (see the getter below), so a peer that received the key while a
// mere "member" correctly becomes an auto-granting key holder too on its next
// open — consistent with "possession de K_vault = capacité de re-partage".
//
// resourceId derivation deliberately drops the vaultId prefix the spec's
// disk layout (§5.3) otherwise anticipates: a WebSocketTransport instance is
// already a single, private point-to-point pairing (unlike the relay hub,
// which multiplexes many vaults over one shared connection and genuinely
// needs a vaultId to route). One process = one vault = one transport here, so
// 'dir' / 'doc/<id>' are unambiguous without it.
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import {
  OwnIdentity, YjsCrdt, Keyring, PeerStore, Session, WebSocketTransport,
  FileSystemStorage, randomBytes, resourceId, toHex,
  loadIdentity, loadKeyring, loadPeers, loadContent, saveAll,
  type IStorage,
} from 'edgesync-protocol/node'
import { VaultDirectory, type DocEntry } from './adapters/vault-directory'
import { ReplayableTransport } from './replayable-transport'
import { writeDoc, removeDoc, moveDoc } from './disk'

const DIR_RESOURCE = 'dir'
const RID_DIR = resourceId(DIR_RESOURCE)

function docResource(docId: string): string {
  return `doc/${docId}`
}

export interface VaultClientOptions {
  /** Local folder to sync. Created if absent; `.edgesync/` is created/read inside it. */
  vaultDir: string
  log?: (line: string) => void
}

interface DocChannel {
  crdt: YjsCrdt
  session: Session
  lastWrittenPath?: string
  retryTimers: ReturnType<typeof setTimeout>[]
}

/** Delays (ms) at which a freshly-opened document Session re-announces itself
 *  to already-connected peers. A single immediate replayPeers() is not enough
 *  for a document created/discovered mid-connection: the OTHER side's own
 *  Session for the same channel is created asynchronously (it has to learn
 *  about the new docId via the directory sync first), so a Hello sent the
 *  instant this Session exists routinely arrives before that Session does and
 *  is silently dropped — and Session.onHello does not itself reply with a
 *  Hello, only a SyncReq, so a lost first Hello does not self-heal. Retrying
 *  a few times bridges that network+CRDT-catch-up delay without touching
 *  Session/messages.ts: an extra Hello is harmless (peers.observe()/onHello's
 *  SyncReq are both idempotent).
 */
const HELLO_RETRY_DELAYS_MS = [50, 150, 350, 750]

export class VaultClient {
  private readonly rawTransport: WebSocketTransport
  private readonly transport: ReplayableTransport
  private readonly directory = new VaultDirectory()
  private readonly docs = new Map<string, DocChannel>()
  private readonly pendingDocCrdts = new Map<string, YjsCrdt>()
  private readonly writeQueues = new Map<string, Promise<void>>()
  private readonly rand = () => randomBytes(32)
  private dirSession!: Session
  private persistTimer: ReturnType<typeof setTimeout> | undefined
  private founder: boolean

  private constructor(
    private readonly vaultDir: string,
    private readonly identity: OwnIdentity,
    private keyring: Keyring,
    private readonly peers: PeerStore,
    private readonly storage: IStorage,
    private freshVault: boolean,
    founder: boolean,
    private readonly log: (line: string) => void,
  ) {
    this.rawTransport = new WebSocketTransport('local')
    this.transport = new ReplayableTransport(this.rawTransport)
    this.founder = founder
  }

  /** Fixed forever: was THIS peer the one whose genesis minted the vault
   *  (§3.1's "premier pair qui initialise un vault vide"). Persisted so it
   *  survives a restart (S6) — unlike isGranting below, this never changes. */
  get isOwner(): boolean {
    return this.founder
  }

  /** True once this client actually possesses K_vault for the current epoch —
   *  the "any K_vault holder may grant/create channels" property (§6.3). This
   *  is DYNAMIC and, unlike isOwner, becomes true for a joiner too once it has
   *  received the key — consistent with "possession de K_vault = capacité de
   *  re-partage" (there is deliberately no permanent capability difference). */
  get isGranting(): boolean {
    const epoch = this.keyring.currentEpoch()
    if (epoch < 0) return false
    const vk = this.keyring.vaultKey(epoch)
    return !!vk && vk.length > 0
  }

  get identityFingerprint(): string {
    return toHex(this.identity.signPub).slice(0, 12)
  }

  static async open(o: VaultClientOptions): Promise<VaultClient> {
    const log = o.log ?? ((line: string) => process.stdout.write(`${line}\n`))
    const storage = new FileSystemStorage(join(o.vaultDir, '.edgesync'))

    let identity = await loadIdentity(storage)
    if (!identity) {
      identity = OwnIdentity.generate()
      await storage.set('secret/identity', identity.serialize())
    }

    const loadedKeyring = await loadKeyring(storage)
    const freshVault = !loadedKeyring
    const keyring = loadedKeyring ?? Keyring.empty()
    const peers = (await loadPeers(storage)) ?? new PeerStore()
    const founderByte = await storage.get('open/founder')
    const founder = founderByte ? founderByte[0] === 1 : false

    const client = new VaultClient(o.vaultDir, identity, keyring, peers, storage, freshVault, founder, log)

    if (!freshVault) {
      // Restart (§7, S6): restore the directory, then every known document's
      // content, and reconstruct any .md file missing from disk.
      await loadContent(storage, RID_DIR, client.directory, client.keyring)
      for (const entry of client.directory.list()) {
        const crdt = new YjsCrdt()
        await loadContent(storage, resourceId(docResource(entry.id)), crdt, client.keyring)
        client.pendingDocCrdts.set(entry.id, crdt)
        await writeDoc(o.vaultDir, entry.path, crdt.text().toString())
      }
    }

    return client
  }

  async listen(port: number): Promise<void> {
    this.finalizeKeyring(true)
    this.buildSessions()
    await this.rawTransport.listen(port)
    this.log(`[edgesync] identite ${this.identityFingerprint}, role ${this.isOwner ? 'owner' : 'membre'}, en ecoute sur ${port}`)
  }

  async dial(url: string): Promise<void> {
    this.finalizeKeyring(false)
    this.buildSessions()
    await this.rawTransport.dial(url)
    this.log(`[edgesync] identite ${this.identityFingerprint}, role ${this.isOwner ? 'owner' : 'membre'}, connecte a ${url}`)
  }

  /** Decide founder vs joiner exactly once, the first time this vault is ever opened. */
  private finalizeKeyring(isFounder: boolean): void {
    if (!this.freshVault) return
    this.founder = isFounder
    void this.storage.set('open/founder', new Uint8Array([isFounder ? 1 : 0]))
    if (isFounder) {
      this.keyring = Keyring.genesis(this.rand)
      this.keyring.mintDocKey(0, RID_DIR, this.rand)
    }
    this.freshVault = false
  }

  private buildSessions(): void {
    this.dirSession = new Session({
      identity: this.identity, crdt: this.directory, keyring: this.keyring,
      transport: this.transport, peers: this.peers, resource: DIR_RESOURCE,
      granting: this.isGranting, storage: this.storage,
    })
    this.directory.onChange(() => this.reconcileDirectory())

    for (const [docId, crdt] of this.pendingDocCrdts) this.openDocSession(docId, crdt)
    this.pendingDocCrdts.clear()

    this.log(`[edgesync] ${this.docs.size} document(s) restaure(s)`)
  }

  /** Open (or, for a restart, resume) one document's Session and wire disk
   *  materialization on every content change — local or remote (§6.2). */
  private openDocSession(docId: string, crdt: YjsCrdt): void {
    const session = new Session({
      identity: this.identity, crdt, keyring: this.keyring, transport: this.transport,
      peers: this.peers, resource: docResource(docId), granting: false, storage: this.storage,
    })
    const channel: DocChannel = { crdt, session, retryTimers: [] }
    this.docs.set(docId, channel)
    // The transport may already be connected (a document opened after the
    // handshake, e.g. one created while both peers are online) — this
    // Session would otherwise never see onPeerUp and never HELLO the peer.
    // Retried a few times: see HELLO_RETRY_DELAYS_MS.
    this.transport.replayPeers()
    for (const delay of HELLO_RETRY_DELAYS_MS) {
      channel.retryTimers.push(setTimeout(() => this.transport.replayPeers(), delay))
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(crdt.doc as any).on('update', () => {
      const entry = this.directory.list().find((e) => e.id === docId)
      if (!entry) return
      channel.lastWrittenPath = entry.path
      this.queueWrite(docId, () => writeDoc(this.vaultDir, entry.path, crdt.text().toString()))
      this.schedulePersist()
    })
  }

  /** React to the directory changing — local creations/renames/removes AND
   *  entries arriving via sync from a remote peer — by opening new document
   *  Sessions and keeping disk materialization in sync (§6.2). */
  private reconcileDirectory(): void {
    const seen = new Set<string>()
    for (const entry of this.directory.list()) {
      seen.add(entry.id)
      const existing = this.docs.get(entry.id)
      if (!existing) {
        const crdt = new YjsCrdt()
        this.openDocSession(entry.id, crdt)
        const channel = this.docs.get(entry.id)!
        channel.lastWrittenPath = entry.path
        this.queueWrite(entry.id, () => writeDoc(this.vaultDir, entry.path, crdt.text().toString()))
        continue
      }
      if (existing.lastWrittenPath && existing.lastWrittenPath !== entry.path) {
        const from = existing.lastWrittenPath
        existing.lastWrittenPath = entry.path
        this.queueWrite(entry.id, () => moveDoc(this.vaultDir, from, entry.path))
      }
    }
    for (const [docId, channel] of [...this.docs]) {
      if (seen.has(docId)) continue
      channel.session.dispose()
      for (const t of channel.retryTimers) clearTimeout(t)
      this.docs.delete(docId)
      if (channel.lastWrittenPath) {
        const path = channel.lastWrittenPath
        this.queueWrite(docId, () => removeDoc(this.vaultDir, path))
      }
    }
    this.schedulePersist()
  }

  /** Serialize disk operations per docId so an initial (possibly empty) write
   *  racing a follow-up edit can never land out of order. */
  private queueWrite(docId: string, fn: () => Promise<void>): void {
    const prev = this.writeQueues.get(docId) ?? Promise.resolve()
    const next = prev.then(fn).catch((e: unknown) => this.log(`[edgesync] ecriture disque echouee pour ${docId}: ${String(e)}`))
    this.writeQueues.set(docId, next)
  }

  private schedulePersist(): void {
    if (this.persistTimer) clearTimeout(this.persistTimer)
    this.persistTimer = setTimeout(() => { void this.persist() }, 500)
  }

  // ── Local editing API (§6.1) — the only path content is edited through;
  // no file watcher, no diffing (see spec §3.2, §6). ────────────────────────

  createDocument(path: string, initialContent = ''): string {
    const docId = randomUUID()
    this.keyring.mintDocKey(this.keyring.currentEpoch(), resourceId(docResource(docId)), this.rand)
    this.directory.add(docId, { path }) // synchronously triggers reconcileDirectory()
    if (initialContent) this.editDocument(docId, initialContent)
    this.pushDirectoryGrant() // §6.3: a fresh channel was minted, re-grant connected peers
    return docId
  }

  /** Whole-content replace: no reconstruction from a before/after diff (§6). */
  editDocument(docId: string, content: string): void {
    const text = this.docs.get(docId)?.crdt.text()
    if (!text) return
    text.delete(0, text.length)
    text.insert(0, content)
  }

  /** Fine-grained alternative to editDocument, for a real editing surface. */
  insertText(docId: string, index: number, text: string): void {
    this.docs.get(docId)?.crdt.text().insert(index, text)
  }

  deleteText(docId: string, index: number, length: number): void {
    this.docs.get(docId)?.crdt.text().delete(index, length)
  }

  renameDocument(docId: string, newPath: string): void {
    this.directory.rename(docId, newPath)
  }

  deleteDocument(docId: string): void {
    this.directory.remove(docId) // channel stays in the Keyring (history), just unlisted
  }

  listDocuments(): DocEntry[] {
    return this.directory.list()
  }

  documentContent(docId: string): string | undefined {
    return this.docs.get(docId)?.crdt.text().toString() ?? this.pendingDocCrdts.get(docId)?.text().toString()
  }

  /** §6.3: possession of K_vault is the capacity to re-share — push the
   *  current full grant (all known channels) to every connected peer. */
  private pushDirectoryGrant(): void {
    if (!this.isGranting) return
    for (const peer of this.transport.peers()) this.dirSession.grantPeer(peer)
  }

  async persist(): Promise<void> {
    await saveAll(this.storage, {
      identity: this.identity, keyring: this.keyring, peers: this.peers,
      channels: [
        { resourceId: RID_DIR, crdt: this.directory },
        ...[...this.docs.entries()].map(([docId, ch]) => ({ resourceId: resourceId(docResource(docId)), crdt: ch.crdt })),
      ],
    })
  }

  dispose(): void {
    if (this.persistTimer) clearTimeout(this.persistTimer)
    this.dirSession?.dispose()
    for (const ch of this.docs.values()) {
      ch.session.dispose()
      for (const t of ch.retryTimers) clearTimeout(t)
    }
    this.rawTransport.close()
  }
}
