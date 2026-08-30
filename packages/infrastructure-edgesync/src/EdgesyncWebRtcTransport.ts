// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// edgesync ITransport over a real WebRTC DataChannel, negotiated through the
// existing blind relay (EdgesyncRelayTransport) purely for signaling. Once a
// peer's DataChannel opens, actual edgesync traffic flows directly between
// browsers — the relay stays subscribed throughout as a live fallback (for
// peers whose negotiation never completes, and if a DataChannel later closes).
//
// Zero backend change: EdgeSyncHub's Relay() already forwards any opaque
// base64 payload to a named peer without interpreting it — signaling messages
// ride the exact same channel as edgesync protocol frames, disambiguated by a
// single reserved tag byte (edgesync's own MsgType enum uses 1..5 today).
//
// NOT to be confused with @savoire/plugin-api's own `ITransport` (a different,
// document-room-oriented port used by SignalRTransport/CollabOrchestrator).
// This implements edgesync-protocol's `ITransport` (raw peer messaging).
import { EdgesyncRelayTransport, type EdgesyncRelayTransportOptions } from './EdgesyncRelayTransport'
import type { ITransport, MessageHandler, PeerHandler } from 'edgesync-protocol'

/** edgesync's own MsgType enum is 1..5 today (poc/edgesync-protocol/src/protocol/messages.ts) — wide margin, never collides. */
const SIGNAL_TAG = 0xF0
const NEGOTIATION_TIMEOUT_MS = 8000

type SignalMsg =
  | { kind: 'offer'; sdp: string }
  | { kind: 'answer'; sdp: string }
  | { kind: 'ice'; candidate: RTCIceCandidateInit }

interface PeerConn {
  pc: RTCPeerConnection
  dc: RTCDataChannel | null
  pendingIce: RTCIceCandidateInit[]
  remoteDescriptionSet: boolean
  timeout: ReturnType<typeof setTimeout>
}

export interface EdgesyncWebRtcTransportOptions extends EdgesyncRelayTransportOptions {
  iceServers?: RTCIceServer[]
  /** Test seam / feature-detect override. */
  rtcPeerConnectionFactory?: (config: RTCConfiguration, peerId: string) => RTCPeerConnection
  /** Test seam: use this relay instance instead of building one from serverUrl/getToken/connection. */
  relay?: EdgesyncRelayTransport
}

const DEFAULT_ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
]

function defaultPcFactory(config: RTCConfiguration, _peerId: string): RTCPeerConnection {
  return new RTCPeerConnection(config)
}

export class EdgesyncWebRtcTransport implements ITransport {
  private readonly relay: EdgesyncRelayTransport
  private readonly iceServers: RTCIceServer[]
  private readonly pcFactory: (config: RTCConfiguration, peerId: string) => RTCPeerConnection
  private readonly rtcAvailable: boolean
  private msg: MessageHandler[] = []
  private readonly peerConns = new Map<string, PeerConn>()
  private disposed = false

  constructor(options: EdgesyncWebRtcTransportOptions = {}) {
    this.relay = options.relay ?? new EdgesyncRelayTransport(options)
    this.iceServers = options.iceServers ?? DEFAULT_ICE_SERVERS
    this.pcFactory = options.rtcPeerConnectionFactory ?? defaultPcFactory
    // typeof on an undeclared global is safe (evaluates to 'undefined', never throws).
    this.rtcAvailable = !!(options.rtcPeerConnectionFactory ?? typeof RTCPeerConnection !== 'undefined')

    this.relay.onMessage((from, bytes) => this.onRelayMessage(from, bytes))
    this.relay.onPeerUp((peerId) => this.handlePeerUp(peerId))
    this.relay.onPeerDown((peerId) => this.teardown(peerId))
  }

  get localId(): string {
    return this.relay.localId
  }

  async connect(vaultId: string): Promise<void> {
    await this.relay.connect(vaultId)
  }

  /** Forwarded: see EdgesyncRelayTransport.replayPeers doc comment. */
  replayPeers(): void {
    this.relay.replayPeers()
  }

  /** Forwarded: see EdgesyncRelayTransport.claimOwner doc comment. */
  async claimOwner(): Promise<boolean> {
    return this.relay.claimOwner()
  }

  onMessage(cb: MessageHandler): () => void {
    this.msg.push(cb)
    return () => { this.msg = this.msg.filter((h) => h !== cb) }
  }

  onPeerUp(cb: PeerHandler): () => void {
    return this.relay.onPeerUp(cb)
  }

  onPeerDown(cb: PeerHandler): () => void {
    return this.relay.onPeerDown(cb)
  }

  peers(): string[] {
    return this.relay.peers()
  }

  /** Prefers an open DataChannel; falls back to the relay otherwise — checked
   *  fresh on every call, no cached "preferred channel" state. */
  send(to: string, bytes: Uint8Array): void {
    const dc = this.peerConns.get(to)?.dc
    if (dc?.readyState === 'open') {
      // TS's DOM lib is stricter than the runtime here (ArrayBufferLike vs
      // ArrayBuffer) — every real browser accepts a plain Uint8Array.
      dc.send(bytes as unknown as ArrayBufferView<ArrayBuffer>)
      return
    }
    this.relay.send(to, bytes)
  }

  async close(): Promise<void> {
    this.disposed = true
    for (const peerId of [...this.peerConns.keys()]) this.teardown(peerId)
    await this.relay.close()
  }

  // ── inbound relay demux: signaling vs real edgesync frames ────────────────
  private onRelayMessage(from: string, bytes: Uint8Array): void {
    if (bytes.length > 0 && bytes[0] === SIGNAL_TAG) {
      this.onSignal(from, bytes.subarray(1))
      return
    }
    for (const h of this.msg) h(from, bytes)
  }

  private onSignal(from: string, payload: Uint8Array): void {
    let msg: SignalMsg
    try {
      msg = JSON.parse(new TextDecoder().decode(payload)) as SignalMsg
    } catch {
      return
    }
    const conn = this.peerConns.get(from)
    if (!conn) return // no negotiation in flight for this peer (torn down, or never started)
    void this.handleSignal(from, conn, msg)
  }

  private async handleSignal(from: string, conn: PeerConn, msg: SignalMsg): Promise<void> {
    if (this.disposed) return
    try {
      if (msg.kind === 'offer') {
        await conn.pc.setRemoteDescription({ type: 'offer', sdp: msg.sdp })
        if (this.disposed) return
        conn.remoteDescriptionSet = true
        await this.flushPendingIce(conn)
        const answer = await conn.pc.createAnswer()
        await conn.pc.setLocalDescription(answer)
        if (this.disposed) return
        this.sendSignal(from, { kind: 'answer', sdp: answer.sdp ?? '' })
      } else if (msg.kind === 'answer') {
        await conn.pc.setRemoteDescription({ type: 'answer', sdp: msg.sdp })
        if (this.disposed) return
        conn.remoteDescriptionSet = true
        await this.flushPendingIce(conn)
      } else if (msg.kind === 'ice') {
        if (conn.remoteDescriptionSet) await conn.pc.addIceCandidate(msg.candidate).catch(() => {})
        else conn.pendingIce.push(msg.candidate)
      }
    } catch {
      // negotiation failed for this peer — stays on the relay, no retry here
    }
  }

  private async flushPendingIce(conn: PeerConn): Promise<void> {
    const pending = conn.pendingIce
    conn.pendingIce = []
    for (const candidate of pending) await conn.pc.addIceCandidate(candidate).catch(() => {})
  }

  private sendSignal(to: string, msg: SignalMsg): void {
    const body = new TextEncoder().encode(JSON.stringify(msg))
    const frame = new Uint8Array(1 + body.length)
    frame[0] = SIGNAL_TAG
    frame.set(body, 1)
    this.relay.send(to, frame)
  }

  // ── peer lifecycle: negotiate opportunistically, always fall back cleanly ─
  private handlePeerUp(peerId: string): void {
    if (!this.rtcAvailable || this.disposed || this.peerConns.has(peerId)) return

    const pc = this.pcFactory({ iceServers: this.iceServers }, peerId)
    const conn: PeerConn = {
      pc, dc: null, pendingIce: [], remoteDescriptionSet: false,
      // Bounded negotiation: if the DataChannel never opens, abandon this
      // attempt (no ICE restart, no retry loop) — the relay keeps carrying
      // traffic regardless; a fresh attempt happens on the next real PeerUp.
      timeout: setTimeout(() => {
        const c = this.peerConns.get(peerId)
        if (c && c.dc?.readyState !== 'open') this.teardown(peerId)
      }, NEGOTIATION_TIMEOUT_MS),
    }
    this.peerConns.set(peerId, conn)

    pc.onicecandidate = (ev) => {
      if (ev.candidate) this.sendSignal(peerId, { kind: 'ice', candidate: ev.candidate.toJSON() })
    }
    pc.ondatachannel = (ev) => this.bindDataChannel(peerId, conn, ev.channel)

    // Deterministic glare tie-break: the lexicographically-lower localId
    // offers; the other side only ever answers. No perfect-negotiation/
    // rollback machinery needed — at most one offer is ever created per pair.
    if (this.localId < peerId) {
      const dc = pc.createDataChannel('edgesync')
      this.bindDataChannel(peerId, conn, dc)
      void (async () => {
        try {
          const offer = await pc.createOffer()
          await pc.setLocalDescription(offer)
          if (this.disposed) return
          this.sendSignal(peerId, { kind: 'offer', sdp: offer.sdp ?? '' })
        } catch {
          // negotiation failed to even start — relay carries everything
        }
      })()
    }
  }

  private bindDataChannel(peerId: string, conn: PeerConn, dc: RTCDataChannel): void {
    dc.binaryType = 'arraybuffer'
    conn.dc = dc
    dc.onmessage = (ev) => {
      const bytes = new Uint8Array(ev.data as ArrayBuffer)
      for (const h of this.msg) h(peerId, bytes)
    }
  }

  private teardown(peerId: string): void {
    const conn = this.peerConns.get(peerId)
    if (!conn) return
    clearTimeout(conn.timeout)
    try { conn.dc?.close() } catch { /* already closed */ }
    try { conn.pc.close() } catch { /* already closed */ }
    this.peerConns.delete(peerId)
  }
}
