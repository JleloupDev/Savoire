// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Composition root of one vault's edgesync sync: a single shared Keyring +
// PeerStore + EdgesyncWebRtcTransport for the whole vault, a directory Session
// (the grant anchor, §4.4 of docs/Architecture/edgesync-local-client-v0-spec.md)
// driving the app's own YMapVaultDirectory, and one Session per currently-open
// document — replacing the old per-document independent-Keyring model
// (EdgesyncDocSession, removed). Documents are opened lazily: only for panels
// an editor actually has open, consistent with the app's existing
// lazy-loading philosophy (a document not open is served by the ordinary
// content-fetch path, not by a live edgesync Session).
//
// Ownership rule: `create()` and `join()` are the two PRIMITIVE, explicit
// entry points — neither ever infers founder-vs-joiner from race-prone state
// (peer counts, timing). The caller always already knows which one it means,
// exactly like poc/edgesync-local-client's VaultClient.listen()/.dial()
// (explicit human choice there). `open()` is a convenience third entry point
// for scenarios that DO have a coordinating server (S2/S3 in the 4-scenario
// model — see docs/Architecture): it asks EdgeSyncHub.ClaimOwner to decide
// automatically, then just calls create() or join() with that answer. The
// server arbitrates only WHO won; it never sees the key itself. A scenario
// with no such server (S1 pure P2P, S4 discoverability-only) simply never
// calls open() — the caller (human action, or a different convention) picks
// create()/join() directly, so the ambiguity this used to paper over with a
// protocol-level tiebreak doesn't exist there to begin with.
//
// Keyring recovery (optional, `keyEscrow`): this class has NO idea which
// server scenario (if any) is active — it only knows whether a `KeyringSource`
// was supplied. Today the app supplies `VaultKeyEscrow` (S3: a blind server
// storing the Keyring wrapped under the account's own K_User — see
// VaultKeyEscrow.ts). If `keyEscrow` already has a Keyring for this vault,
// create()/join()/open() all skip genesis/claimOwner entirely — this device's
// account is already a known member. For S1 (no server at all), the caller
// simply omits `keyEscrow`. The escrowed snapshot is kept current, not just
// written once at genesis: openDocument()/openIndex() re-save it every time
// they mint a new per-resource key, so a later reload's restored Keyring can
// still decrypt content opened after the vault was founded (see those
// methods — a doc/index key minted but never re-escrowed would otherwise be
// silently replaced by an unrelated one on the next restore, per
// loadContent()'s silent-drop-on-bad-key behaviour).
//
// Content persistence (optional, `storage`): unrelated to `keyEscrow` — it
// persists channel CONTENT (directory/documents/indexes), never the Keyring
// itself (secret/* keys never reach `storage` — see IStorage's own contract).
// Re-persisted (debounced) on every local or remote change, same pattern as
// poc/edgesync-local-client/src/client.ts's schedulePersist().
import type * as Y from 'yjs'
import {
  OwnIdentity, YjsCrdt, Keyring, PeerStore, Session, randomBytes, resourceId, MsgType,
  loadContent, saveAll, type IStorage, type PersistableChannel,
} from 'edgesync-protocol'
import { EdgesyncWebRtcTransport } from './EdgesyncWebRtcTransport'
import { EdgesyncAwarenessChannel, AWARENESS_TAG } from './EdgesyncAwarenessChannel'
import { EdgesyncIndexChannel } from './EdgesyncIndexChannel'
import type { YMapVaultDirectory } from './YMapVaultDirectory'

// TypeScript 5.9 + moduleResolution:bundler fails to follow Yjs's .js→.d.ts
// re-export chain — Y.Doc's declared type is missing the Observable mixin's
// on()/off() (see YjsCrdtAdapter.ts for the same issue). A minimal structural
// type is enough here: this file only needs the 'update' event to schedule a
// persist, never anything else off the raw Y.Doc.
interface UpdateEmitter {
  on(event: 'update', cb: () => void): void
  off(event: 'update', cb: () => void): void
}

/** Structural subset of @savoire/plugin-api's ICRDT presence methods — kept
 *  structural (not imported) for the same reason as EdgesyncVaultSessionLike
 *  in @savoire/application: avoids a dependency cycle. Satisfied today by
 *  YjsCrdtAdapter. */
export interface CrdtPresence {
  onLocalPresenceChanged(cb: (bytes: Uint8Array, changedClients: number[]) => void): () => void
  applyRemotePresence(bytes: Uint8Array): void
}

/** Structural — deliberately NOT tied to any concrete implementation (e.g.
 *  VaultKeyEscrow) or to any server-scenario concept. This class only ever
 *  asks "do I have a source, or not" — it never knows whether that source is
 *  S3's blind server escrow, a future S1 no-op, or anything else. Keeps
 *  poc/edgesync-protocol (which knows nothing about ANY of this) and this
 *  composition root cleanly separated from "how do I recover my Keyring". */
export interface KeyringSource {
  fetch(vaultId: string): Promise<Keyring | undefined>
  save(vaultId: string, keyring: Keyring): Promise<void>
}

/** See poc/edgesync-local-client/src/client.ts's HELLO_RETRY_DELAYS_MS: a
 *  document Session opened after the transport is already connected (the
 *  normal case here — a document is opened well after vault activation)
 *  races the remote peer's own Session into existence: the first Hello sent
 *  routinely arrives before that Session does and is silently dropped, and
 *  Session.onHello does not itself reply with a Hello (only a SyncReq), so a
 *  lost first Hello never self-heals. Retrying replayPeers() a few times
 *  bridges that gap without touching Session/messages.ts.
 *
 *  The SAME race also hits the vault-directory Session itself here (unlike
 *  the local-client CLI): the owner-election rule needs `transport.peers()`
 *  inspected BEFORE the Session can be built, forcing a connect()-then-
 *  construct order — so the very first Hello between the two peers can be
 *  lost the same way. Both open() and openDocument() below retry. This same
 *  window doubles as the opportunity for a joiner to escrow its own copy of
 *  the Keyring once a live grant lands — see finalize() below. */
const HELLO_RETRY_DELAYS_MS = [50, 150, 350, 750]

/** Debounce window for persist() after a local or remote change — same value
 *  as poc/edgesync-local-client/src/client.ts's schedulePersist(). */
const PERSIST_DEBOUNCE_MS = 500

export interface EdgesyncVaultSessionOptions {
  vaultId: string
  /** 32-byte Ed25519 seed (e.g. an ISeedExportingIdentityProvider's exportSignSeed()). */
  identitySeed: Uint8Array
  directory: YMapVaultDirectory
  serverUrl?: string
  getToken?: () => string | null
  /** Test seam: bypasses serverUrl. */
  transport?: EdgesyncWebRtcTransport
  /** Optional CONTENT persistence port (directory/documents/indexes only —
   *  never the Keyring). Omitted = in-memory-only content, as before this
   *  ever existed. */
  storage?: IStorage
  /** Optional Keyring recovery — see the class doc comment above. Omitted =
   *  today's original behaviour (a reload always re-runs genesis/join). */
  keyEscrow?: KeyringSource
}

interface DocChannel {
  session: Session
  crdt: YjsCrdt
  retryTimers: ReturnType<typeof setTimeout>[]
  presenceCleanup?: () => void
  unsubUpdate: () => void
}

interface IndexChannelEntry {
  session: Session
  channel: EdgesyncIndexChannel
  crdt: YjsCrdt
  retryTimers: ReturnType<typeof setTimeout>[]
  unsubUpdate: () => void
}

export class EdgesyncVaultSession {
  private readonly docs = new Map<string, DocChannel>()
  private readonly indexes = new Map<string, IndexChannelEntry>()
  private readonly rand = () => randomBytes(32)
  private dirRetryTimers: ReturnType<typeof setTimeout>[] = []
  private dirUnsubChange?: () => void
  private persistTimer: ReturnType<typeof setTimeout> | undefined

  private constructor(
    private readonly vaultId: string,
    private readonly identity: OwnIdentity,
    private readonly keyring: Keyring,
    private readonly peers: PeerStore,
    private readonly transport: EdgesyncWebRtcTransport,
    private readonly dirSession: Session,
    /** True when this peer self-elected as key holder (first in the room).
     *  Always false for a session restored via keyEscrow — isOwner is a
     *  fixed historical fact ("I founded this vault") that the escrow path
     *  deliberately doesn't try to reconstruct; nothing in the protocol
     *  depends on it, only `isGranting` (dynamic, derived from the Keyring)
     *  does. */
    readonly isOwner: boolean,
    private readonly directory: YMapVaultDirectory,
    private readonly storage?: IStorage,
    private readonly keyEscrow?: KeyringSource,
  ) {}

  /** Explicit: this caller is founding the vault's edgesync session — mints
   *  the genesis K_vault. The caller must already know no one else will also
   *  call create() for this room (human choice in S1/S4; guaranteed by
   *  ClaimOwner when reached via open() in S2/S3). Skipped entirely if
   *  `keyEscrow` already knows this vault (see restore()). */
  static async create(o: EdgesyncVaultSessionOptions): Promise<EdgesyncVaultSession> {
    const keyring = await EdgesyncVaultSession.restore(o)
    const transport = await EdgesyncVaultSession.connectTransport(o)
    if (keyring) return EdgesyncVaultSession.finalize(transport, o, false, keyring)
    return EdgesyncVaultSession.finalize(transport, o, true)
  }

  /** Explicit: this caller is joining an already-founded vault's edgesync
   *  session — starts with an empty Keyring and waits for a KEY grant.
   *  Skipped entirely if `keyEscrow` already knows this vault. */
  static async join(o: EdgesyncVaultSessionOptions): Promise<EdgesyncVaultSession> {
    const keyring = await EdgesyncVaultSession.restore(o)
    const transport = await EdgesyncVaultSession.connectTransport(o)
    if (keyring) return EdgesyncVaultSession.finalize(transport, o, false, keyring)
    return EdgesyncVaultSession.finalize(transport, o, false)
  }

  /** Convenience for scenarios with a coordinating server (S2/S3): asks
   *  EdgeSyncHub.ClaimOwner to decide create-vs-join automatically instead of
   *  the caller choosing explicitly. Equivalent to calling create()/join()
   *  directly with that answer — see the class doc comment above. Skipped
   *  entirely (no election at all) if `keyEscrow` already knows this vault: a
   *  returning member does not need to re-race for ownership. */
  static async open(o: EdgesyncVaultSessionOptions): Promise<EdgesyncVaultSession> {
    const keyring = await EdgesyncVaultSession.restore(o)
    const transport = await EdgesyncVaultSession.connectTransport(o)
    if (keyring) return EdgesyncVaultSession.finalize(transport, o, false, keyring)
    const isOwner = await transport.claimOwner()
    console.info(`[EdgeSync] claimOwner -> ${isOwner}`)
    return EdgesyncVaultSession.finalize(transport, o, isOwner)
  }

  /** Try to recover this vault's Keyring via `keyEscrow`. Returns undefined
   *  for a vault this account has never escrowed a key for (no `keyEscrow`
   *  configured, or genuinely nothing stored yet) — the caller then falls
   *  back to its normal genesis/empty/claimOwner behaviour. A wrong K_User
   *  is NOT swallowed here — KeyringSource.fetch() is expected to reject
   *  distinctly in that case (see VaultKeyEscrow's WrongVaultKeyError) so the
   *  UI layer can show a clear error instead of silently starting a blank
   *  vault. */
  private static async restore(o: EdgesyncVaultSessionOptions): Promise<Keyring | undefined> {
    if (!o.keyEscrow) {
      console.info('[EdgeSync] restore() — no keyEscrow configured, skipping')
      return undefined
    }
    const keyring = await o.keyEscrow.fetch(o.vaultId)
    if (!keyring) {
      console.info('[EdgeSync] restore() — no escrowed keyring found, treating as a fresh vault')
      return undefined
    }
    console.info(`[EdgeSync] restore() — found escrowed keyring (epoch=${keyring.currentEpoch()})`)
    return keyring
  }

  private static async connectTransport(o: EdgesyncVaultSessionOptions): Promise<EdgesyncWebRtcTransport> {
    const transport = o.transport
      ?? new EdgesyncWebRtcTransport({ serverUrl: o.serverUrl, getToken: o.getToken })
    // Diagnostic only: the protocol itself never logs (silent-drop philosophy
    // — a malformed/rejected frame from a peer must never throw), which makes
    // "nothing happened" and "something arrived and was rejected" impossible
    // to tell apart from the outside. This just names the frame type; it
    // never touches routing/verification.
    transport.onMessage((from, bytes) => {
      const label = bytes[0] === AWARENESS_TAG ? 'Awareness' : (MsgType[bytes[0]] ?? `type=${bytes[0]}`)
      console.info(`[EdgeSync] <- ${label} from=${from} (${bytes.length}o)`)
    })
    console.info('[EdgeSync] connecting to vault room', o.vaultId)
    await transport.connect(o.vaultId)
    console.info('[EdgeSync] connected, peers already present:', transport.peers())
    return transport
  }

  private static finalize(
    transport: EdgesyncWebRtcTransport,
    o: EdgesyncVaultSessionOptions,
    isOwner: boolean,
    restoredKeyring?: Keyring,
  ): EdgesyncVaultSession {
    const rand = () => randomBytes(32)
    const keyring = restoredKeyring ?? (isOwner ? Keyring.genesis(rand) : Keyring.empty())
    const identity = OwnIdentity.fromSignSeed(o.identitySeed)
    const peers = new PeerStore()
    if (isOwner && !restoredKeyring) keyring.mintDocKey(0, resourceId(o.vaultId), rand)

    const dirSession = new Session({
      identity, crdt: o.directory, keyring, transport, peers,
      resource: o.vaultId, granting: isOwner, storage: o.storage,
    })

    const vault = new EdgesyncVaultSession(o.vaultId, identity, keyring, peers, transport, dirSession, isOwner, o.directory, o.storage, o.keyEscrow)
    console.info(`[EdgeSync] vault session open (owner=${isOwner})`)

    // Restore the directory's last known CONTENT from storage — unrelated to
    // the Keyring restore above (that's keyEscrow's job). Idempotent (Yjs
    // update application is commutative), so safe even if the directory
    // already picked up state from a race with the transport connecting.
    if (o.storage) void loadContent(o.storage, resourceId(o.vaultId), o.directory, keyring)
    vault.dirUnsubChange = o.directory.onChange(() => vault.schedulePersist())

    // Fresh genesis: escrow this Keyring immediately so the next reload can
    // recover it. A joiner (isOwner=false, no restored keyring) has nothing
    // to escrow yet — it must wait for a live KEY grant first, handled below
    // in the same retry window already used for HELLO replay.
    if (isOwner && !restoredKeyring) void o.keyEscrow?.save(o.vaultId, keyring)

    // The Session was built after connect(): replay presence so it HELLOs the
    // peers already in the room. A single replay isn't enough — see
    // HELLO_RETRY_DELAYS_MS above.
    transport.replayPeers()
    let escrowedThisSession = isOwner || !!restoredKeyring
    for (const delay of HELLO_RETRY_DELAYS_MS) {
      vault.dirRetryTimers.push(setTimeout(() => {
        transport.replayPeers()
        console.info(`[EdgeSync] replay @${delay}ms — peers:`, transport.peers(), 'granting:', vault.isGranting)
        // A joiner becomes granting-capable once a live KEY grant lands —
        // that's this account's first chance to escrow its own copy (wrapped
        // under ITS OWN K_User, distinct from whoever granted it).
        if (!escrowedThisSession && vault.isGranting) {
          escrowedThisSession = true
          void o.keyEscrow?.save(o.vaultId, keyring)
        }
      }, delay))
    }

    return vault
  }

  /** True once this peer actually possesses K_vault for the current epoch —
   *  the "any K_vault holder may grant/create channels" property. Dynamic,
   *  unlike isOwner: a joiner becomes granting-capable too once it has
   *  received the key ("possession de K_vault = capacité de re-partage"). */
  get isGranting(): boolean {
    const epoch = this.keyring.currentEpoch()
    if (epoch < 0) return false
    const vk = this.keyring.vaultKey(epoch)
    return !!vk && vk.length > 0
  }

  /** Open (or reuse) the Session for a currently-open document. `presence`
   *  (optional — satisfied by YjsCrdtAdapter) wires peer cursors: broadcast
   *  on local awareness change, apply on remote update. See
   *  EdgesyncAwarenessChannel's doc comment for why this is a separate,
   *  simpler path than Session (no HELLO/history — ephemeral, self-healing
   *  on the next live update). */
  openDocument(docId: string, doc: unknown, presence?: CrdtPresence): Session {
    const existing = this.docs.get(docId)
    if (existing) {
      // A remount (StrictMode, prop churn) can call openDocument again for a
      // channel that's already open — wire presence now if it wasn't wired
      // the first time (e.g. this call is the first one to pass it).
      if (presence && !existing.presenceCleanup) {
        existing.presenceCleanup = this.wirePresence(this.vaultId, docId, presence)
      }
      return existing.session
    }

    const resource = `${this.vaultId}/${docId}`
    const rid = resourceId(resource)
    const epoch = this.keyring.currentEpoch()
    console.info(`[EdgeSync] openDocument ${docId} — granting=${this.isGranting} epoch=${epoch} hasKey=${!!this.keyring.docKey(epoch, rid)}`)
    if (this.isGranting && !this.keyring.docKey(epoch, rid)) {
      this.keyring.mintDocKey(epoch, rid, this.rand)
      // A fresh channel was minted: push an updated grant to every connected
      // peer — possession of K_vault is the capacity to re-share (§6.3).
      for (const peer of this.transport.peers()) this.dirSession.grantPeer(peer)
      // Re-escrow: the snapshot saved at genesis/restore time only has the
      // keys known back then. Without this, a doc key minted here would
      // never reach the server, so the NEXT reload's restored keyring lacks
      // it — openDocument() would mint ANOTHER, unrelated key and silently
      // fail to decrypt this doc's already-persisted content (see
      // loadContent() in poc/edgesync-protocol/src/protocol/persistence.ts —
      // wrong/missing key is a silent no-op there, not an error).
      void this.keyEscrow?.save(this.vaultId, this.keyring)
    }

    const crdt = new YjsCrdt(doc as Y.Doc)
    if (this.storage) void loadContent(this.storage, rid, crdt, this.keyring)

    const session = new Session({
      identity: this.identity, crdt, keyring: this.keyring,
      transport: this.transport, peers: this.peers, resource, granting: false, storage: this.storage,
    })
    const updateHandler = () => this.schedulePersist()
    ;(doc as UpdateEmitter).on('update', updateHandler)

    const channel: DocChannel = {
      session, crdt, retryTimers: [],
      unsubUpdate: () => (doc as UpdateEmitter).off('update', updateHandler),
    }
    if (presence) channel.presenceCleanup = this.wirePresence(this.vaultId, docId, presence)

    this.docs.set(docId, channel)

    this.transport.replayPeers()
    for (const delay of HELLO_RETRY_DELAYS_MS) {
      channel.retryTimers.push(setTimeout(() => this.transport.replayPeers(), delay))
    }

    return session
  }

  private wirePresence(vaultId: string, docId: string, presence: CrdtPresence): () => void {
    const resource = `${vaultId}/${docId}`
    const awareness = new EdgesyncAwarenessChannel({ resource, keyring: this.keyring, transport: this.transport })
    // Diagnostic only, same reasoning as connectTransport's frame logger: a
    // silent no-op (no key yet, no peers) and a silent success look
    // identical from the outside otherwise.
    const unsubLocal = presence.onLocalPresenceChanged((bytes, changed) => {
      console.info(`[EdgeSync] presence: local change on ${docId} (clients ${changed.join(',')}, ${bytes.length}o) -> broadcasting to`, this.transport.peers())
      awareness.broadcast(bytes)
    })
    const unsubRemote = awareness.onUpdate((bytes) => {
      console.info(`[EdgeSync] presence: applying remote update on ${docId} (${bytes.length}o)`)
      presence.applyRemotePresence(bytes)
    })
    return () => {
      unsubLocal()
      unsubRemote()
      awareness.dispose()
    }
  }

  closeDocument(docId: string): void {
    const channel = this.docs.get(docId)
    if (!channel) return
    channel.session.dispose()
    channel.presenceCleanup?.()
    channel.unsubUpdate()
    for (const t of channel.retryTimers) clearTimeout(t)
    this.docs.delete(docId)
  }

  /** Open (or reuse) the CRDT channel for one index namespace (e.g.
   *  "wikilinks", "hashtags" — see EdgesyncIndexChannel's doc comment for
   *  why this is one Session per namespace, not one shared blob, and why it
   *  goes through the real protocol instead of the awareness shortcut).
   *  Vault-scoped and granted exactly like a document channel: opening a
   *  namespace no one else has opened yet mints and shares its key the same
   *  way a brand new document does. */
  openIndex(namespace: string): EdgesyncIndexChannel {
    const existing = this.indexes.get(namespace)
    if (existing) return existing.channel

    const resource = `${this.vaultId}/index/${namespace}`
    const rid = resourceId(resource)
    const epoch = this.keyring.currentEpoch()
    if (this.isGranting && !this.keyring.docKey(epoch, rid)) {
      this.keyring.mintDocKey(epoch, rid, this.rand)
      for (const peer of this.transport.peers()) this.dirSession.grantPeer(peer)
      // See the matching comment in openDocument() — without this, this
      // index's key never reaches the server and the next reload can't
      // decrypt its persisted content either.
      void this.keyEscrow?.save(this.vaultId, this.keyring)
    }

    const channel = new EdgesyncIndexChannel()
    const rawDoc = channel.rawDoc as Y.Doc
    const crdt = new YjsCrdt(rawDoc)
    if (this.storage) void loadContent(this.storage, rid, crdt, this.keyring)

    const session = new Session({
      identity: this.identity, crdt, keyring: this.keyring,
      transport: this.transport, peers: this.peers, resource, granting: false, storage: this.storage,
    })
    const updateHandler = () => this.schedulePersist()
    ;(rawDoc as unknown as UpdateEmitter).on('update', updateHandler)

    const entry: IndexChannelEntry = {
      session, channel, crdt, retryTimers: [],
      unsubUpdate: () => (rawDoc as unknown as UpdateEmitter).off('update', updateHandler),
    }
    this.indexes.set(namespace, entry)

    this.transport.replayPeers()
    for (const delay of HELLO_RETRY_DELAYS_MS) {
      entry.retryTimers.push(setTimeout(() => this.transport.replayPeers(), delay))
    }

    return channel
  }

  closeIndex(namespace: string): void {
    const entry = this.indexes.get(namespace)
    if (!entry) return
    entry.session.dispose()
    entry.unsubUpdate()
    for (const t of entry.retryTimers) clearTimeout(t)
    this.indexes.delete(namespace)
  }

  private schedulePersist(): void {
    if (!this.storage) return // no-op with no storage configured — don't even schedule the timer
    if (this.persistTimer) clearTimeout(this.persistTimer)
    this.persistTimer = setTimeout(() => {
      this.persist().catch((err) => console.error('[EdgeSync] persist() failed', err))
    }, PERSIST_DEBOUNCE_MS)
  }

  /** Persist every open CONTENT channel (directory, documents, indexes) in a
   *  single saveAll() call — never the Keyring (see the class doc comment).
   *  One write of the shared identity/keyring/peers state no matter how many
   *  channels are open, rather than one redundant write per Session.persist()
   *  — the identity/keyring/peers fields land under `secret/*` keys, which a
   *  server-backed IStorage silently refuses (see RemoteEdgesyncBlobStorage),
   *  so in practice only the content channels actually get written server-side. */
  async persist(): Promise<void> {
    if (!this.storage) return
    const channels: PersistableChannel[] = [
      { resourceId: resourceId(this.vaultId), crdt: this.directory },
      ...[...this.docs.entries()].map(([docId, ch]): PersistableChannel =>
        ({ resourceId: resourceId(`${this.vaultId}/${docId}`), crdt: ch.crdt })),
      ...[...this.indexes.entries()].map(([ns, entry]): PersistableChannel =>
        ({ resourceId: resourceId(`${this.vaultId}/index/${ns}`), crdt: entry.crdt })),
    ]
    console.info(`[EdgeSync] persist() — ${channels.length} channel(s), epoch=${this.keyring.currentEpoch()}`)
    await saveAll(this.storage, { identity: this.identity, keyring: this.keyring, peers: this.peers, channels })
    console.info('[EdgeSync] persist() done')
  }

  async dispose(): Promise<void> {
    if (this.persistTimer) clearTimeout(this.persistTimer)
    // Flush the latest state before tearing down — a keystroke or directory
    // change right before closing a tab/switching vaults must not be lost to
    // the debounce window never firing.
    await this.persist()

    this.dirUnsubChange?.()
    this.dirSession.dispose()
    for (const t of this.dirRetryTimers) clearTimeout(t)
    for (const channel of this.docs.values()) {
      channel.session.dispose()
      channel.presenceCleanup?.()
      channel.unsubUpdate()
      for (const t of channel.retryTimers) clearTimeout(t)
    }
    this.docs.clear()
    for (const entry of this.indexes.values()) {
      entry.session.dispose()
      entry.unsubUpdate()
      for (const t of entry.retryTimers) clearTimeout(t)
    }
    this.indexes.clear()
    // Awaited: a caller switching to a different vault right after must not
    // proceed until this vault's connection is actually torn down (a
    // fire-and-forget close here previously let a new activateVault() race
    // ahead of the old SignalR connection actually closing).
    await this.transport.close()
  }
}
