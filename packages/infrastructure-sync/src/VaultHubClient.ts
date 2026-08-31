// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import {
  HubConnectionBuilder,
  HubConnection,
  HubConnectionState,
  LogLevel,
} from '@microsoft/signalr'
import type { IDocumentMeta, IVaultDirectory } from '@savoire/platform'

const VAULT_COMPACT_THRESHOLD = 100

// Relais d'index : le hub transporte des mises a jour CRDT OPAQUES, une par
// namespace. Remplace l'ancien PushIndexOp, qui expediait le markdown complet
// au serveur pour qu'il le sequence et le rediffuse.

function toBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunk = 8192
  for (let i = 0; i < bytes.length; i += chunk)
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  return btoa(binary)
}

function fromBase64(b64: string): Uint8Array {
  return Uint8Array.from(atob(b64), c => c.charCodeAt(0))
}

export class VaultHubClient {
  private connection: HubConnection | null = null
  private connectPromise: Promise<void> | null = null
  private disposed = false
  private disposing = false
  private pendingCreates = new Map<string, Promise<IDocumentMeta>>()
  private authBlockedUntil = 0
  private indexCallbacks = new Map<string, ((update: Uint8Array) => void)[]>()
  private unsubLocalVaultUpdate: (() => void) | null = null

  constructor(
    private readonly serverUrl: string,
    private readonly vaultId: string,
    private readonly directory: IVaultDirectory,
    private readonly onChanged: () => void,
    private readonly getToken: () => string | null = () => null,
    private readonly onConnectionChange?: (state: 'connected' | 'disconnected') => void,
  ) {
    this.unsubLocalVaultUpdate = this.directory.onLocalUpdate(
      (update) => void this.pushVaultUpdate(update),
    )
  }

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

      // ── Vault CRDT init (replaces VaultSnapshot) ──────────────────────────
      this.connection.on('InitVault', (_vaultId: string, ops: string[]) => {
        for (const op of ops) this.directory.applyUpdate(fromBase64(op))
        if (ops.length > VAULT_COMPACT_THRESHOLD) {
          const snapshot = toBase64(this.directory.encodeFullState())
          void this.connection?.invoke('SnapshotVault', this.vaultId, snapshot).catch(console.error)
        }
        this.onChanged()
      })

      // ── Incremental vault CRDT updates ────────────────────────────────────
      this.connection.on('VaultOperationReceived', (_vaultId: string, opBase64: string) => {
        this.directory.applyUpdate(fromBase64(opBase64))
        this.onChanged()
      })

      // ── Index : mises a jour CRDT opaques, par namespace ──────────────────
      this.connection.on('IndexUpdateReceived', (_vaultId: string, namespace: string, updateBase64: string) => {
        const cbs = this.indexCallbacks.get(namespace)
        if (!cbs) return
        const update = fromBase64(updateBase64)
        for (const cb of cbs) cb(update)
      })

      // ── Reconnection: rejoin to get fresh vault CRDT state ────────────────
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

  // ── Vault CRDT ────────────────────────────────────────────────────────────

  async pushVaultUpdate(update: Uint8Array): Promise<void> {
    if (!this.isConnected) return
    try {
      await this.connection!.invoke('PushVaultOperation', this.vaultId, toBase64(update))
    } catch (err) {
      console.warn('[VaultHub] pushVaultUpdate failed', err)
    }
  }

  // ── Index ops ─────────────────────────────────────────────────────────────

  /** Rejoint le canal d'index d'un namespace et rend les ops deja stockees. */
  async joinIndex(namespace: string): Promise<Uint8Array[]> {
    if (this.disposed) return []
    try {
      const connection = await this._ensureConnected()
      const ops = await connection.invoke<string[]>('JoinIndex', this.vaultId, namespace)
      return ops.map(fromBase64)
    } catch (err) {
      console.warn('[VaultHub] joinIndex failed', err)
      return []
    }
  }

  async pushIndexUpdate(namespace: string, update: Uint8Array): Promise<void> {
    if (!this.isConnected) return
    try {
      await this.connection!.invoke('PushIndexUpdate', this.vaultId, namespace, toBase64(update))
    } catch (err) {
      console.warn('[VaultHub] pushIndexUpdate failed', err)
    }
  }

  onIndexUpdate(namespace: string, cb: (update: Uint8Array) => void): () => void {
    const list = this.indexCallbacks.get(namespace) ?? []
    list.push(cb)
    this.indexCallbacks.set(namespace, list)
    return () => {
      const cur = this.indexCallbacks.get(namespace)
      if (!cur) return
      this.indexCallbacks.set(namespace, cur.filter(x => x !== cb))
    }
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  async dispose(): Promise<void> {
    this.disposed = true
    this.disposing = true
    this.unsubLocalVaultUpdate?.()
    this.unsubLocalVaultUpdate = null
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
