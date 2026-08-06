// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// In-memory stand-in for EdgeSyncHub: introduces peers of a vault room and
// forwards opaque frames, exactly like the server-side blind relay. Shared by
// the transport contract tests and the EdgesyncVaultSession tests.
import type { RelayConnection } from '@savoire/infrastructure-sync'

export class FakeRelayServer {
  private readonly conns = new Map<string, FakeServerConnection>()
  private readonly owners = new Map<string, string>()
  private next = 0

  attach(): FakeServerConnection {
    return new FakeServerConnection(this, `conn-${this.next++}`)
  }

  join(conn: FakeServerConnection, vaultId: string): string[] {
    const existing = [...this.conns.values()]
      .filter((c) => c.vaultId === vaultId)
      .map((c) => c.connectionId!)
    this.conns.set(conn.connectionId!, conn)
    conn.vaultId = vaultId
    for (const other of this.conns.values()) {
      if (other !== conn && other.vaultId === vaultId) {
        other.fire('PeerUp', vaultId, conn.connectionId!)
      }
    }
    return existing
  }

  /** Mirrors EdgeSyncHub.ClaimOwner: first caller per vaultId wins. */
  claimOwner(conn: FakeServerConnection, vaultId: string): boolean {
    if (this.owners.has(vaultId)) return false
    this.owners.set(vaultId, conn.connectionId!)
    return true
  }

  relay(fromId: string, vaultId: string, to: string, frameBase64: string): void {
    const target = this.conns.get(to)
    if (!target || target.vaultId !== vaultId) return
    queueMicrotask(() => target.fire('Frame', vaultId, fromId, frameBase64))
  }
}

export class FakeServerConnection implements RelayConnection {
  connectionId: string | null
  vaultId = ''
  private readonly handlers = new Map<string, (...args: string[]) => void>()

  constructor(private readonly server: FakeRelayServer, id: string) {
    this.connectionId = id
  }

  on(method: string, cb: (...args: never[]) => void): void {
    this.handlers.set(method, cb as (...args: string[]) => void)
  }

  async invoke<T>(method: string, ...args: unknown[]): Promise<T> {
    if (method === 'Join') return this.server.join(this, args[0] as string) as T
    if (method === 'ClaimOwner') return this.server.claimOwner(this, args[0] as string) as T
    if (method === 'Relay') {
      this.server.relay(this.connectionId!, args[0] as string, args[1] as string, args[2] as string)
    }
    return undefined as T
  }

  async start(): Promise<void> {}
  async stop(): Promise<void> {}

  fire(method: string, ...args: string[]): void {
    this.handlers.get(method)?.(...args)
  }
}
