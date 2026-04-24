// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import {
  HubConnection,
  HubConnectionBuilder,
  HubConnectionState,
  LogLevel,
} from '@microsoft/signalr'
import type { IIndexSyncGateway, IndexSyncOp } from '@savoire/domain-index'

export interface SignalRIndexSyncGatewayOptions {
  serverUrl?: string
  getToken?: () => string | null | undefined
}

// WebSocket dispatcher for the anchor index.
// The server receives IndexSyncOps and broadcasts them to all clients in the vault group.
// No server-side index state — the server is a pure message router.
export class SignalRIndexSyncGateway implements IIndexSyncGateway {
  private readonly serverUrl: string
  private readonly getToken: () => string | null | undefined
  private connection: HubConnection | null = null
  private readonly remoteHandlers = new Set<(op: IndexSyncOp) => void>()
  private joinedVaultId: string | null = null

  constructor(options: SignalRIndexSyncGatewayOptions = {}) {
    this.serverUrl = options.serverUrl ?? ''
    this.getToken = options.getToken ?? (() => null)
  }

  async connect(vaultId: string): Promise<void> {
    const conn = this.ensureConnection()
    if (conn.state === HubConnectionState.Disconnected) await conn.start()
    await conn.invoke('JoinIndexGroup', vaultId)
    this.joinedVaultId = vaultId
  }

  async disconnect(): Promise<void> {
    if (!this.connection) return
    if (this.connection.state !== HubConnectionState.Disconnected) {
      await this.connection.stop()
    }
    this.connection = null
    this.joinedVaultId = null
  }

  broadcast(op: IndexSyncOp): void {
    const conn = this.connection
    if (!conn || conn.state !== HubConnectionState.Connected) return
    void conn.invoke('BroadcastIndexOp', op)
  }

  onRemote(handler: (op: IndexSyncOp) => void): () => void {
    this.remoteHandlers.add(handler)
    return () => this.remoteHandlers.delete(handler)
  }

  private ensureConnection(): HubConnection {
    if (this.connection) return this.connection
    this.connection = new HubConnectionBuilder()
      .withUrl(`${this.serverUrl}/hubs/index`, {
        accessTokenFactory: () => this.getToken() ?? '',
      })
      .configureLogging(LogLevel.None)
      .withAutomaticReconnect()
      .build()

    this.connection.on('IndexOp', (op: IndexSyncOp) => {
      for (const h of this.remoteHandlers) h(op)
    })

    this.connection.onreconnected(async () => {
      if (!this.connection || !this.joinedVaultId) return
      await this.connection.invoke('JoinIndexGroup', this.joinedVaultId)
    })

    return this.connection
  }
}
