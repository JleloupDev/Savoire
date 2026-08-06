// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import {
  HubConnectionBuilder,
  HubConnection,
  HubConnectionState,
  LogLevel,
} from '@microsoft/signalr'
import type { IDocumentMeta, VaultClient } from '@savoire/platform'

interface IndexOpAppliedEvent {
  seq: number
  docId: string
  path: string
  markdownContent: string
}

export class VaultHubClient {
  private connection: HubConnection | null = null
  private connectPromise: Promise<void> | null = null
  private disposed = false
  private disposing = false
  private pendingCreates = new Map<string, Promise<IDocumentMeta>>()
  private authBlockedUntil = 0
  private indexOpCallbacks: ((evt: IndexOpAppliedEvent) => void)[] = []

  constructor(
    private readonly serverUrl: string,
    private readonly vaultId: string,
    // Kept for signature stability (callers still pass these); the vault CRDT
    // now syncs via EdgesyncVaultSession instead — this hub only carries index
    // ops, but JoinVault must still be called (it also gates the index-op
    // broadcast group — see VaultHub.cs).
    _vaultClient: VaultClient,
    _onChanged: () => void,
    private readonly getToken: () => string | null = () => null,
    private readonly onConnectionChange?: (state: 'connected' | 'disconnected') => void,
  ) {}

  async connect(): Promise<void> {
    if (this.disposed) return
    if (Date.now() < this.authBlockedUntil) return
    if (this.connection?.state === HubConnectionState.Connected) return
    if (this.connectPromise) return this.connectPromise

    if (!this.connection) {
      this.connection = new HubConnectionBuilder()
        .withUrl(`${this.serverUrl}/hubs/vault`, {
          accessTokenFactory: () => this.getToken() ?? '',
        })
        .configureLogging(LogLevel.None)
        .withAutomaticReconnect()
        .build()

      // Vault directory/document sync now goes through EdgesyncVaultSession
      // (E2E-encrypted, shared per-vault Keyring) — this hub no longer drives
      // it. 'InitVault'/'VaultOperationReceived' are intentionally not
      // handled here any more; the server still emits them but nothing
      // listens. JoinVault is still called below (it also gates the
      // index-op broadcast group, see VaultHub.cs).

      // ── Index ops ─────────────────────────────────────────────────────────
      this.connection.on('IndexOpApplied', (evt: IndexOpAppliedEvent) => {
        for (const cb of this.indexOpCallbacks) cb(evt)
      })

      // ── Reconnection: rejoin (index-op group membership) ──────────────────
      this.connection.onreconnected(async () => {
        this.onConnectionChange?.('connected')
        try {
          await this.connection!.invoke('JoinVault', this.vaultId)
        } catch (err) {
          console.error('[VaultHub] Failed to rejoin after reconnect', err)
          if (this.isUnauthorizedError(err)) this.blockOnUnauthorized()
        }
      })

      this.connection.onclose((err?: Error) => {
        if (!this.disposing) this.onConnectionChange?.('disconnected')
        if (this.isUnauthorizedError(err)) this.blockOnUnauthorized()
      })
    }

    this.connectPromise = (async () => {
      try {
        if (this.connection!.state === HubConnectionState.Disconnected)
          await this.connection!.start()
        if (this.connection!.state === HubConnectionState.Connected)
          await this.connection!.invoke('JoinVault', this.vaultId)
      } catch (err) {
        if (this.isUnauthorizedError(err)) this.blockOnUnauthorized()
        console.warn('[VaultHub] Connection failed — filetree may be stale', err)
      } finally {
        this.connectPromise = null
      }
    })()

    return this.connectPromise
  }

  get isConnected(): boolean {
    return this.connection?.state === HubConnectionState.Connected
  }

  // ── Index ops ─────────────────────────────────────────────────────────────

  async pushIndexOp(docId: string, path: string, markdownContent: string): Promise<number | null> {
    if (!this.isConnected) return null
    try {
      const connection = await this._ensureConnected()
      return await connection.invoke<number>('PushIndexOp', {
        vaultId: this.vaultId, docId, path, markdownContent,
      })
    } catch (err) {
      console.warn('[VaultHub] pushIndexOp failed', err)
      return null
    }
  }

  onIndexOpApplied(cb: (evt: { seq: number; docId: string; path: string; markdownContent: string }) => void): () => void {
    this.indexOpCallbacks.push(cb)
    return () => { this.indexOpCallbacks = this.indexOpCallbacks.filter(x => x !== cb) }
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  async dispose(): Promise<void> {
    this.disposed = true
    this.disposing = true
    this.pendingCreates.clear()
    if (this.connection) {
      try { await this.connection.stop() } catch { /* ignore */ }
      this.connection = null
    }
  }

  private async _ensureConnected(): Promise<HubConnection> {
    await this.connect()
    if (!this.connection || this.connection.state !== HubConnectionState.Connected)
      throw new Error('VaultHub not connected')
    return this.connection
  }

  private isUnauthorizedError(err: unknown): boolean {
    const text = String(err ?? '')
    return text.includes('401') || text.toLowerCase().includes('unauthorized')
  }

  private blockOnUnauthorized(): void {
    this.authBlockedUntil = Date.now() + 60_000
    if (this.connection && this.connection.state !== HubConnectionState.Disconnected)
      void this.connection.stop().catch(() => {})
  }

}
