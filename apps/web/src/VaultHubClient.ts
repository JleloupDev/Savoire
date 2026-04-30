// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
/**
 * VaultHubClient — SignalR client for /hubs/vault.
 *
 * DECISION: Lives in the web app layer (not @savoire/platform) because SignalR
 * is a transport concern. Platform stays transport-agnostic.
 *
 * Connects to VaultHub, receives snapshot on JoinVault, and listens for
 * real-time document events (created, renamed, deleted). Updates VaultClient's
 * in-memory cache so that vault.list() never hits the server.
 */
import {
  HubConnectionBuilder,
  HubConnection,
  HubConnectionState,
  LogLevel,
} from '@microsoft/signalr'
import type { IDocumentMeta, VaultClient } from '@savoire/platform'

// ── Hub DTO types (match server VaultHubDtos.cs) ──────────────────────────────

interface VaultSnapshotItem {
  id: string
  path: string
  title: string | null
  updatedAt: string // ISO 8601
}

interface DocumentCreatedEvent {
  id: string
  vaultId: string
  path: string
  title: string | null
  createdAt: string
}

interface DocumentRenamedEvent {
  id: string
  oldPath: string
  newPath: string
  updatedAt: string
}

interface DocumentDeletedEvent {
  id: string
  path: string
  deletedAt: string
}

interface IndexOpAppliedEvent {
  seq: number
  docId: string
  path: string
  markdownContent: string
}

// ── Client ────────────────────────────────────────────────────────────────────

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
    private readonly vaultClient: VaultClient,
    /** Called after any cache mutation so the UI can re-render (notifyVaultChange). */
    private readonly onChanged: () => void,
    /** JWT Bearer token factory — required by the [Authorize] hub. */
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

      // ── Snapshot (received once after JoinVault) ──────────────────────────
      this.connection.on('VaultSnapshot', (items: VaultSnapshotItem[]) => {
        console.debug(`[VaultHub] Snapshot: ${items.length} document(s)`)
        this.vaultClient.setSnapshot(
          items.map(i => ({ id: i.id, path: i.path })),
        )
        this.onChanged()
      })

      // ── Real-time events ─────────────────────────────────────────────────
      this.connection.on('DocumentCreated', (evt: DocumentCreatedEvent) => {
        console.debug(`[VaultHub] DocumentCreated: ${evt.path}`)
        this.vaultClient.addDocument({ id: evt.id, path: evt.path })
        this.onChanged()
      })

      this.connection.on('DocumentRenamed', (evt: DocumentRenamedEvent) => {
        console.debug(`[VaultHub] DocumentRenamed: ${evt.oldPath} → ${evt.newPath}`)
        this.vaultClient.renameDocumentInCache(evt.id, evt.newPath)
        this.onChanged()
      })

      this.connection.on('DocumentDeleted', (evt: DocumentDeletedEvent) => {
        console.debug(`[VaultHub] DocumentDeleted: ${evt.path}`)
        this.vaultClient.removeDocument(evt.id)
        this.onChanged()
      })

      this.connection.on('IndexOpApplied', (evt: IndexOpAppliedEvent) => {
        for (const cb of this.indexOpCallbacks) cb(evt)
      })

      // ── Reconnection: rejoin vault to get fresh snapshot ─────────────────
      this.connection.onreconnected(async () => {
        console.debug('[VaultHub] Reconnected — rejoining vault')
        this.onConnectionChange?.('connected')
        try {
          await this.connection!.invoke('JoinVault', this.vaultId)
        } catch (err) {
          console.error('[VaultHub] Failed to rejoin after reconnect', err)
          if (this.isUnauthorizedError(err)) this.blockOnUnauthorized()
        }
      })

      this.connection.onclose((err) => {
        if (!this.disposing) this.onConnectionChange?.('disconnected')
        if (this.isUnauthorizedError(err)) this.blockOnUnauthorized()
      })
    }

    this.connectPromise = (async () => {
      // ── Start & join ───────────────────────────────────────────────────
      try {
        if (this.connection!.state === HubConnectionState.Disconnected) {
          await this.connection!.start()
        }
        if (this.connection!.state === HubConnectionState.Connected) {
          await this.connection!.invoke('JoinVault', this.vaultId)
          console.debug(`[VaultHub] Connected & joined vault ${this.vaultId}`)
        }
      } catch (err) {
        if (this.isUnauthorizedError(err)) this.blockOnUnauthorized()
        console.warn('[VaultHub] Connection failed — filetree may be stale', err)
      } finally {
        this.connectPromise = null
      }
    })()

    return this.connectPromise
  }

  /** Whether the hub connection is currently up. */
  get isConnected(): boolean {
    return this.connection?.state === HubConnectionState.Connected
  }

  async createDocument(path: string, title?: string | null): Promise<IDocumentMeta> {
    const connection = await this._ensureConnected()
    const normalizedPath = this._normalizePath(path)
    const existing = this.pendingCreates.get(normalizedPath)
    if (existing) return existing

    const request = (async () => {
      try {
        const created = await connection.invoke<VaultSnapshotItem>(
          'CreateDocument',
          this.vaultId,
          normalizedPath,
          title ?? this._defaultTitle(normalizedPath),
        )
        return { id: created.id, path: created.path }
      } finally {
        this.pendingCreates.delete(normalizedPath)
      }
    })()

    this.pendingCreates.set(normalizedPath, request)
    return request
  }

  async renameDocument(documentId: string, newPath: string): Promise<void> {
    const connection = await this._ensureConnected()
    await connection.invoke('RenameDocument', documentId, this._normalizePath(newPath))
  }

  async deleteDocument(documentId: string): Promise<void> {
    const connection = await this._ensureConnected()
    await connection.invoke('DeleteDocument', documentId)
  }

  /**
   * Envoie une op d'index au serveur. Retourne le seq assigné.
   * Fire-and-forget si la connexion est indisponible (offline mode).
   */
  async pushIndexOp(docId: string, path: string, markdownContent: string): Promise<number | null> {
    if (!this.isConnected) return null
    try {
      const connection = await this._ensureConnected()
      const seq = await connection.invoke<number>('PushIndexOp', {
        vaultId: this.vaultId,
        docId,
        path,
        markdownContent,
      })
      return seq
    } catch (err) {
      console.warn('[VaultHub] pushIndexOp failed — offline?', err)
      return null
    }
  }

  /**
   * Subscribe to IndexOpApplied events from other clients.
   * Returns unsubscribe function.
   */
  onIndexOpApplied(cb: (evt: { seq: number; docId: string; path: string; markdownContent: string }) => void): () => void {
    this.indexOpCallbacks.push(cb)
    return () => { this.indexOpCallbacks = this.indexOpCallbacks.filter(x => x !== cb) }
  }

  /** Cleanly disconnect from VaultHub. */
  async dispose(): Promise<void> {
    this.disposed = true
    this.disposing = true
    this.pendingCreates.clear()
    if (this.connection) {
      try { await this.connection.stop() } catch { /* POC: ignore */ }
      this.connection = null
    }
  }

  private async _ensureConnected(): Promise<HubConnection> {
    await this.connect()
    if (!this.connection || this.connection.state !== HubConnectionState.Connected) {
      throw new Error('VaultHub not connected')
    }
    return this.connection
  }

  private isUnauthorizedError(err: unknown): boolean {
    const text = String(err ?? '')
    return text.includes('401') || text.toLowerCase().includes('unauthorized')
  }

  private blockOnUnauthorized(): void {
    // Anti-thrash: pause reconnect attempts for a short window when token is invalid.
    this.authBlockedUntil = Date.now() + 60_000
    if (this.connection && this.connection.state !== HubConnectionState.Disconnected) {
      void this.connection.stop().catch(() => {})
    }
  }

  private _normalizePath(path: string): string {
    return path.includes('.') ? path : `${path}.md`
  }

  private _defaultTitle(path: string): string | null {
    const fileName = path.split('/').at(-1)?.replace(/\.[^.]+$/, '').trim()
    return fileName ? fileName : null
  }

}
