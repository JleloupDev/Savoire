// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Decorator adding a replayPeers() escape hatch to any ITransport. A Session
// built AFTER a peer is already connected (a document Session opened once the
// WebSocket handshake already completed — the normal case for a document
// created while both peers are online, spec §6.2/§6.3) would otherwise never
// see onPeerUp fire and would never send its own HELLO: ITransport.onPeerUp()
// only notifies FUTURE connections, not ones already up. Same fix as
// EdgesyncRelayTransport.replayPeers() in packages/infrastructure-sync
// (built for the exact same race against the SignalR relay), generalized here
// to wrap any ITransport instead of being relay-specific — websocket-transport.ts
// itself stays untouched (spec §9: reuse exactly).
import type { ITransport, MessageHandler, PeerHandler } from 'edgesync-protocol/node'

export class ReplayableTransport implements ITransport {
  readonly localId: string
  private msg: MessageHandler[] = []
  private up: PeerHandler[] = []
  private down: PeerHandler[] = []
  private readonly present = new Set<string>()

  constructor(private readonly inner: ITransport) {
    this.localId = inner.localId
    inner.onMessage((from, bytes) => { for (const h of this.msg) h(from, bytes) })
    inner.onPeerUp((id) => { this.present.add(id); for (const h of this.up) h(id) })
    inner.onPeerDown((id) => { this.present.delete(id); for (const h of this.down) h(id) })
  }

  onMessage(cb: MessageHandler): () => void {
    this.msg.push(cb)
    return () => { this.msg = this.msg.filter((h) => h !== cb) }
  }

  onPeerUp(cb: PeerHandler): () => void {
    this.up.push(cb)
    return () => { this.up = this.up.filter((h) => h !== cb) }
  }

  onPeerDown(cb: PeerHandler): () => void {
    this.down.push(cb)
    return () => { this.down = this.down.filter((h) => h !== cb) }
  }

  send(to: string, bytes: Uint8Array): void {
    this.inner.send(to, bytes)
  }

  peers(): string[] {
    return this.inner.peers()
  }

  /** Re-announce every already-connected peer to onPeerUp handlers added after the fact. */
  replayPeers(): void {
    for (const id of this.present) for (const h of this.up) h(id)
  }
}
