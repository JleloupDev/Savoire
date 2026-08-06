// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// The single orchestrator. It wires Identity + Keyring + CRDT + Transport:
//   local update -> encrypt(current epoch) -> sign -> frame -> transport
//   inbound      -> route -> verify -> decrypt -> crdt.applyRemote
// It knows nothing about Yjs or about the network: only the ports.
import { OwnIdentity, verify, type PeerIdentity } from '../core/identity'
import {
  encrypt, decrypt, seal, encodeEnvelope, decodeEnvelope, signedRegion, resourceId, concat, randomBytes,
} from '../core/envelope'
import { Keyring } from '../core/keyring'
import type { ICrdt } from '../ports/crdt'
import type { ITransport } from '../ports/transport'
import { PeerStore } from '../ports/peer-store'
import type { IStorage } from '../ports/storage'
import { saveAll } from './persistence'
import {
  MsgType, frame, unframe,
  encodeHello, decodeHello, encodeKey, decodeKey, encodeSyncReq, decodeSyncReq,
} from './messages'

export interface SessionOpts {
  identity: OwnIdentity
  crdt: ICrdt
  keyring: Keyring
  transport: ITransport
  peers: PeerStore
  resource: string
  /** A key-holder that grants the current epoch to peers as they appear. */
  granting?: boolean
  /** Optional persistence port. The app decides at-rest protection (ADR-0011). */
  storage?: IStorage
}

export class Session {
  private readonly id: OwnIdentity
  private readonly crdt: ICrdt
  private readonly keyring: Keyring
  private readonly transport: ITransport
  private readonly peers: PeerStore
  private readonly resource: string
  private readonly resourceId: Uint8Array
  private readonly granting: boolean
  private readonly storage?: IStorage
  private readonly idByPeer = new Map<string, PeerIdentity>()
  private readonly cleanups: (() => void)[] = []
  private readonly rand = () => randomBytes(32)

  constructor(o: SessionOpts) {
    this.id = o.identity
    this.crdt = o.crdt
    this.keyring = o.keyring
    this.transport = o.transport
    this.peers = o.peers
    this.resource = o.resource
    this.resourceId = resourceId(o.resource)
    this.granting = o.granting ?? false
    this.storage = o.storage

    this.cleanups.push(this.crdt.onLocalUpdate((u) => this.publishOp(u)))
    this.cleanups.push(this.transport.onMessage((from, b) => this.onMessage(from, b)))
    this.cleanups.push(this.transport.onPeerUp((peer) => this.onPeerUp(peer)))
  }

  dispose(): void {
    for (const c of this.cleanups) c()
  }

  /**
   * Persist current state through the storage port. The app chooses WHEN to call
   * this (e.g. debounced on change) and HOW values are protected at rest.
   */
  async persist(): Promise<void> {
    if (!this.storage) return
    await saveAll(this.storage, {
      identity: this.id, keyring: this.keyring, peers: this.peers,
      channels: [{ resourceId: this.resourceId, crdt: this.crdt }],
    })
  }

  /** Rotate to a fresh epoch and deliver it to all peers except `exclude`. */
  rotate(exclude: string[] = []): void {
    const keys = this.keyring.rotate(this.rand)
    for (const peer of this.transport.peers()) {
      if (!exclude.includes(peer)) this.grantPeer(peer, keys.epoch)
    }
  }

  /** Revoke a peer: rotate and deliver the new epoch to everyone but them. */
  revoke(peerId: string): void {
    this.rotate([peerId])
  }

  /** Seal & send an epoch's key (every known channel's K_doc) to a connected,
   *  identified peer. Only meaningful on the vault-directory Session (§4.4):
   *  its `resource` is the vault id, so this is the sole grant anchor. */
  grantPeer(peer: string, epoch = this.keyring.currentEpoch()): void {
    const identity = this.idByPeer.get(peer)
    if (!identity) return
    const d = this.keyring.delivery(epoch)
    if (!d) return
    const sealedVaultKey = seal(identity.boxPub, d.vaultKey)
    // Authenticate the grant: sign over the vault, epoch, recipient, sealed
    // vault key and the WHOLE batch of docWraps, so a captured KEY cannot be
    // replayed to another peer/vault, forged by a non-key-holder, or have its
    // docWraps batch tampered with (partial-recombination, cf. §4.3).
    const region = this.keyGrantRegion(epoch, identity.signPub, sealedVaultKey, d.docWraps)
    const sig = this.id.sign(region)
    this.transport.send(peer, frame(MsgType.Key, encodeKey({
      resource: this.resource, epoch, sealedVaultKey, docWraps: d.docWraps,
      grantorSignPub: this.id.signPub, recipientSignPub: identity.signPub, sig,
    })))
  }

  /** Bytes a grantor signs in a KEY: vault ‖ epoch ‖ recipient ‖ sealed ‖ every (resourceId‖docWrap) in order. */
  private keyGrantRegion(epoch: number, recipientSignPub: Uint8Array, sealedVaultKey: Uint8Array, docWraps: { resourceId: Uint8Array; docWrap: Uint8Array }[]): Uint8Array {
    const parts = [this.resourceId, u32be(epoch), recipientSignPub, sealedVaultKey]
    for (const d of docWraps) parts.push(d.resourceId, d.docWrap)
    return concat(...parts)
  }

  // ── outbound ────────────────────────────────────────────────────────────
  private onPeerUp(peer: string): void {
    this.transport.send(peer, frame(MsgType.Hello, this.hello()))
  }

  private hello(): Uint8Array {
    const nonce = randomBytes(24)
    const sig = this.id.sign(this.helloTranscript(this.id.signPub, this.id.boxPub, nonce))
    return encodeHello({ signPub: this.id.signPub, boxPub: this.id.boxPub, nonce, sig })
  }

  /**
   * Bytes a peer signs in its HELLO: version ‖ signPub ‖ boxPub ‖ channel ‖ nonce.
   * Binding boxPub stops a relay from swapping it (and stealing sealed keys);
   * binding the channel + version stops cross-context replay of the handshake.
   */
  private helloTranscript(signPub: Uint8Array, boxPub: Uint8Array, nonce: Uint8Array): Uint8Array {
    return concat(new Uint8Array([Session.PROTO]), signPub, boxPub, this.resourceId, nonce)
  }

  private publishOp(update: Uint8Array): void {
    const epoch = this.keyring.currentEpoch()
    const key = this.keyring.docKey(epoch, this.resourceId)
    if (!key) return // not keyed yet; peers will catch us up once we are
    const env = this.sealOp(epoch, key, update)
    for (const peer of this.transport.peers()) this.transport.send(peer, frame(MsgType.Op, env))
  }

  private sealOp(epoch: number, key: Uint8Array, update: Uint8Array): Uint8Array {
    const { nonce, ciphertext } = encrypt(key, update)
    const sig = this.id.sign(signedRegion(this.resourceId, epoch, nonce, ciphertext))
    return encodeEnvelope({ resourceId: this.resourceId, epoch, nonce, ciphertext, sig, signerPub: this.id.signPub })
  }

  // ── inbound ─────────────────────────────────────────────────────────────
  /** Hard ceiling on an inbound frame. Anything bigger is dropped unparsed. */
  private static readonly MAX_MSG = 1 << 20 // 1 MiB
  /** Handshake/protocol version, bound into the HELLO transcript. */
  private static readonly PROTO = 1

  private onMessage(from: string, bytes: Uint8Array): void {
    // Per-peer isolation: a malformed or hostile frame from one peer must never
    // throw out of here and take down the session/process. All decoders below
    // (unframe, decode*, unseal, observe) may throw on crafted input; we treat
    // any failure as a silent drop, consistent with the protocol's no-error-
    // message philosophy.
    if (bytes.length < 1 || bytes.length > Session.MAX_MSG) return
    try {
      const { type, payload } = unframe(bytes)
      switch (type) {
        case MsgType.Hello: return this.onHello(from, payload)
        case MsgType.Op: return this.onOp(payload)
        case MsgType.Key: return this.onKey(payload)
        case MsgType.SyncReq: return this.onSyncReq(from, payload)
        case MsgType.SyncResp: return this.onOp(payload)
      }
    } catch {
      // drop: bad frame from `from`, session stays alive
    }
  }

  private onHello(from: string, payload: Uint8Array): void {
    const h = decodeHello(payload)
    if (!verify(h.sig, this.helloTranscript(h.signPub, h.boxPub, h.nonce), h.signPub)) return
    const identity: PeerIdentity = { signPub: h.signPub, boxPub: h.boxPub }
    // A SyncReq only ever carries the SENDER's own state vector (it's "here's
    // what I have, tell me what I'm missing") — it never causes the sender to
    // learn what THEY are missing. If this Session existed long before `from`
    // ever showed interest (typical: a document written well before another
    // peer opens it), only ONE side's Hello would normally ever arrive here,
    // so only ONE direction of SyncReq/SyncResp would ever fire and the other
    // peer's already-written content would never reach us. Echoing our own
    // HELLO back the first time we see a peer here (never again — idempotent
    // via idByPeer, so this can't ping-pong) makes their onHello fire too,
    // which sends THEIR SyncReq to us and completes the exchange both ways.
    const firstTimeSeeingThisPeer = !this.idByPeer.has(from)
    this.peers.observe(from, identity) // TOFU
    this.idByPeer.set(from, identity)
    if (this.granting && this.keyring.currentEpoch() >= 0) this.grantPeer(from)
    if (firstTimeSeeingThisPeer) this.transport.send(from, frame(MsgType.Hello, this.hello()))
    this.transport.send(from, frame(MsgType.SyncReq, encodeSyncReq({ resourceId: this.resourceId, stateVector: this.crdt.stateVector() })))
  }

  private onOp(payload: Uint8Array): void {
    const env = decodeEnvelope(payload)
    // Routing/binding: an op only concerns this channel. On a shared transport
    // other channels' ops are delivered here too; drop anything not ours.
    if (!eqBytes(env.resourceId, this.resourceId)) return
    if (!verify(env.sig, signedRegion(env.resourceId, env.epoch, env.nonce, env.ciphertext), env.signerPub)) return
    // B1 author signature: the op's author is `signerPub`. Accept only ops from a
    // KNOWN (pinned) user — no rights yet. The ACL will replace this known-user
    // gate with "member authorized at this position" (ADR-0009). On sync/snapshot
    // paths `signerPub` is the forwarder, not the original author (B2 fixes that).
    if (!this.peers.knowsSigner(env.signerPub)) return
    // Write-revocation (best-effort in P2P): reject any op from a PAST epoch, on
    // every path. Thanks to encrypt-at-send a legitimate SYNC_RESP is always at
    // the current epoch, so no exemption is needed — and exempting it was the
    // hole that let a revoked peer launder an old-epoch op via SYNC_RESP.
    if (env.epoch < this.keyring.currentEpoch()) return
    const key = this.keyring.docKey(env.epoch, this.resourceId)
    if (!key) return // cannot read this epoch (revoked, or not yet keyed)
    let update: Uint8Array
    try {
      update = decrypt(key, env.nonce, env.ciphertext)
    } catch {
      return
    }
    this.crdt.applyRemote(update)
  }

  private onKey(payload: Uint8Array): void {
    const k = decodeKey(payload)
    if (k.resource !== this.resource) return
    // This KEY must be addressed to us (no replay of someone else's grant)...
    if (!eqBytes(k.recipientSignPub, this.id.signPub)) return
    // ...issued by a peer we have pinned (in v0 any known key-holder may grant;
    // the ACL will later restrict this to authorized grantors)...
    if (!this.peers.knowsSigner(k.grantorSignPub)) return
    // ...and actually signed by that grantor over this exact grant, INCLUDING
    // every docWrap in the batch (partial-recombination is rejected here).
    const region = this.keyGrantRegion(k.epoch, k.recipientSignPub, k.sealedVaultKey, k.docWraps)
    if (!verify(k.sig, region, k.grantorSignPub)) return
    const vaultKey = this.id.unseal(k.sealedVaultKey)
    this.keyring.import(k.epoch, vaultKey, k.docWraps)
    const epoch = this.keyring.currentEpoch()
    const key = this.keyring.docKey(epoch, this.resourceId)
    if (!key) return
    // Encrypt-at-send: now keyed, push our state under the new epoch and
    // re-request theirs (now decryptable).
    const snapshot = this.sealOp(epoch, key, this.crdt.snapshot())
    for (const peer of this.transport.peers()) {
      this.transport.send(peer, frame(MsgType.Op, snapshot))
      this.transport.send(peer, frame(MsgType.SyncReq, encodeSyncReq({ resourceId: this.resourceId, stateVector: this.crdt.stateVector() })))
    }
  }

  private onSyncReq(from: string, payload: Uint8Array): void {
    const { resourceId: rid, stateVector } = decodeSyncReq(payload)
    if (!eqBytes(rid, this.resourceId)) return // not our channel
    const epoch = this.keyring.currentEpoch()
    const key = this.keyring.docKey(epoch, this.resourceId)
    if (!key) return
    const diff = this.crdt.diffSince(stateVector)
    this.transport.send(from, frame(MsgType.SyncResp, this.sealOp(epoch, key, diff)))
  }
}

function eqBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}

function u32be(n: number): Uint8Array {
  const b = new Uint8Array(4)
  new DataView(b.buffer).setUint32(0, n, false)
  return b
}
