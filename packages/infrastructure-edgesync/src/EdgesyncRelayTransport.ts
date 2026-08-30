// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// edgesync ITransport over the server's blind relay (EdgeSyncHub).
// The hub only introduces peers of a vault room and forwards OPAQUE frames
// (E2E-encrypted/signed by the protocol); it never reads them. One transport
// instance = one vault room. Several Sessions (vault-dir, content channels,
// indexes) can share it: the protocol routes by resourceId.

import {
  HubConnectionBuilder,
  LogLevel,
  type HubConnection,
} from '@microsoft/signalr'
import {
  toBase64, fromBase64,
  type ITransport, type MessageHandler, type PeerHandler,
} from 'edgesync-protocol'

/** Minimal surface of HubConnection — injectable in tests. */
export interface RelayConnection {
  readonly connectionId: string | null
  on(methodName: string, cb: (...args: never[]) => void): void
  invoke<T = unknown>(methodName: string, ...args: unknown[]): Promise<T>
  start(): Promise<void>
  stop(): Promise<void>
  /** SignalR auto-reconnect succeeded (with a fresh connection id): re-Join is needed. */
  onreconnected?(cb: (connectionId?: string) => void): void
  /** The connection gave up (or was intentionally stopped). */
  onclose?(cb: (error?: Error) => void): void
}

export interface EdgesyncRelayTransportOptions {
  serverUrl?: string
  getToken?: () => string | null
  /** Test seam: bypasses serverUrl and uses this connection. */
  connection?: RelayConnection
}

export class EdgesyncRelayTransport implements ITransport {
  private readonly conn: RelayConnection
  private vaultId = ''
  private msg: MessageHandler[] = []
  private up: PeerHandler[] = []
  private down: PeerHandler[] = []
  private readonly present = new Set<string>()
  // Frames can arrive between connect() and the Session's subscription (the
  // owner rule needs the room inspected before the Session exists): buffer
  // until the first onMessage subscriber, then flush in order.
  private pending: { from: string; bytes: Uint8Array }[] = []
  private static readonly MAX_PENDING = 256

  constructor(options: EdgesyncRelayTransportOptions) {
    this.conn = options.connection ?? buildConnection(options)
  }

  /** SignalR connection id — the peer's opaque address on the relay. */
  get localId(): string {
    return this.conn.connectionId ?? ''
  }

  onMessage(cb: MessageHandler): () => void {
    this.msg.push(cb)
    if (this.pending.length > 0) {
      const buffered = this.pending
      this.pending = []
      for (const { from, bytes } of buffered) cb(from, bytes)
    }
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

  /** Start the connection and enter the vault room; announces existing peers. */
  async connect(vaultId: string): Promise<void> {
    this.vaultId = vaultId

    this.conn.on('Frame', (vid: string, from: string, frameBase64: string) => {
      if (vid !== this.vaultId) return
      let bytes: Uint8Array
      try { bytes = fromBase64(frameBase64) } catch { return }
      if (this.msg.length === 0) {
        if (this.pending.length < EdgesyncRelayTransport.MAX_PENDING) this.pending.push({ from, bytes })
        return
      }
      for (const h of this.msg) h(from, bytes)
    })
    this.conn.on('PeerUp', (vid: string, peerId: string) => {
      if (vid !== this.vaultId) return
      this.present.add(peerId)
      for (const h of this.up) h(peerId)
    })
    this.conn.on('PeerDown', (vid: string, peerId: string) => {
      if (vid !== this.vaultId) return
      this.present.delete(peerId)
      for (const h of this.down) h(peerId)
    })

    await this.conn.start()
    const existing = await this.conn.invoke<string[]>('Join', vaultId)
    for (const peerId of existing) {
      this.present.add(peerId)
      for (const h of this.up) h(peerId)
    }

    // A SignalR auto-reconnect gets a fresh connection id and forgets room
    // membership: re-Join and reconcile presence (fire PeerDown for anyone no
    // longer in the room, PeerUp for anyone present — including a peer whose
    // own id also changed, which existing Sessions need to re-HELLO).
    this.conn.onreconnected?.(async () => {
      let refreshed: string[]
      try {
        refreshed = await this.conn.invoke<string[]>('Join', this.vaultId)
      } catch {
        return
      }
      const stillPresent = new Set(refreshed)
      for (const peerId of [...this.present]) {
        if (!stillPresent.has(peerId)) {
          this.present.delete(peerId)
          for (const h of this.down) h(peerId)
        }
      }
      for (const peerId of refreshed) {
        if (!this.present.has(peerId)) {
          this.present.add(peerId)
          for (const h of this.up) h(peerId)
        }
      }
    })
    this.conn.onclose?.(() => {
      for (const peerId of [...this.present]) {
        this.present.delete(peerId)
        for (const h of this.down) h(peerId)
      }
    })
  }

  /**
   * Atomically claim the right to mint this vault's genesis key. The server
   * arbitrates: at most one caller ever gets `true` for this room (until it
   * empties and a fresh election can happen), removing the old client-side
   * "peers().length === 0" race where two peers connecting close together
   * could both self-elect and mint independent, unmergeable keys.
   */
  async claimOwner(): Promise<boolean> {
    return this.conn.invoke<boolean>('ClaimOwner', this.vaultId)
  }

  /**
   * Re-announce every present peer to the onPeerUp handlers. A Session built
   * AFTER connect() (owner rule needs to inspect the room first) would miss
   * the initial PeerUp burst and never HELLO anyone — this replays it.
   */
  replayPeers(): void {
    for (const peerId of this.present) {
      for (const h of this.up) h(peerId)
    }
  }

  send(to: string, bytes: Uint8Array): void {
    void this.conn.invoke('Relay', this.vaultId, to, toBase64(bytes)).catch(() => {
      // Relay failure = peer unreachable; the protocol treats silence as absence.
    })
  }

  peers(): string[] {
    return [...this.present]
  }

  async close(): Promise<void> {
    await this.conn.stop().catch(() => {})
  }
}

function buildConnection(options: EdgesyncRelayTransportOptions): RelayConnection {
  const { serverUrl = '', getToken } = options
  const conn: HubConnection = new HubConnectionBuilder()
    .withUrl(`${serverUrl}/hubs/edgesync`, {
      ...(getToken ? { accessTokenFactory: () => getToken() ?? '' } : {}),
    })
    .configureLogging(LogLevel.None)
    .withAutomaticReconnect()
    .build()
  // HubConnection satisfies RelayConnection at runtime; its .d.ts does not
  // structurally line up under this tsconfig's resolution, hence the cast.
  return conn as unknown as RelayConnection
}
