// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import {
  HubConnection,
  HubConnectionBuilder,
  HubConnectionState,
  LogLevel,
} from '@microsoft/signalr'
import type { DocumentMeta, IVaultIndexSyncGateway } from '@savoire/domain-sync'
import { mapDocumentMeta } from './mappers'

export interface SignalRVaultIndexSyncGatewayOptions {
  serverUrl?: string
  getToken?: () => string | null | undefined
}

interface VaultSnapshotItem {
  id?: string
  path?: string
  updatedAt?: string
  Id?: string
  Path?: string
  UpdatedAt?: string
}

interface DocumentCreatedEvent extends VaultSnapshotItem {
  vaultId?: string
  VaultId?: string
}

interface DocumentRenamedEvent {
  id?: string
  newPath?: string
  Id?: string
  NewPath?: string
}

interface DocumentDeletedEvent {
  id?: string
  Id?: string
}

export class SignalRVaultIndexSyncGateway implements IVaultIndexSyncGateway {
  private readonly serverUrl: string
  private readonly getToken: () => string | null | undefined
  private connection: HubConnection | null = null
  private joinedVaultId: string | null = null

  private readonly snapshotListeners = new Set<(docs: DocumentMeta[]) => void>()
  private readonly createdListeners = new Set<(meta: DocumentMeta) => void>()
  private readonly renamedListeners = new Set<(documentId: string, newPath: string) => void>()
  private readonly deletedListeners = new Set<(documentId: string) => void>()

  constructor(options: SignalRVaultIndexSyncGatewayOptions = {}) {
    this.serverUrl = options.serverUrl ?? ''
    this.getToken = options.getToken ?? (() => null)
  }

  async connect(vaultId: string): Promise<void> {
    const conn = this.ensureConnection()
    if (conn.state === HubConnectionState.Disconnected) await conn.start()
    await conn.invoke('JoinVault', vaultId)
    this.joinedVaultId = vaultId
  }

  async disconnect(_vaultId: string): Promise<void> {
    if (!this.connection) return
    if (this.connection.state !== HubConnectionState.Disconnected) await this.connection.stop()
    this.connection = null
    this.joinedVaultId = null
  }

  onSnapshot(cb: (docs: DocumentMeta[]) => void): () => void {
    this.snapshotListeners.add(cb)
    return () => {
      this.snapshotListeners.delete(cb)
    }
  }

  onCreated(cb: (meta: DocumentMeta) => void): () => void {
    this.createdListeners.add(cb)
    return () => {
      this.createdListeners.delete(cb)
    }
  }

  onRenamed(cb: (documentId: string, newPath: string) => void): () => void {
    this.renamedListeners.add(cb)
    return () => {
      this.renamedListeners.delete(cb)
    }
  }

  onDeleted(cb: (documentId: string) => void): () => void {
    this.deletedListeners.add(cb)
    return () => {
      this.deletedListeners.delete(cb)
    }
  }

  private ensureConnection(): HubConnection {
    if (this.connection) return this.connection
    this.connection = new HubConnectionBuilder()
      .withUrl(`${this.serverUrl}/hubs/vault`, {
        accessTokenFactory: () => this.getToken() ?? '',
      })
      .configureLogging(LogLevel.None)
      .withAutomaticReconnect()
      .build()

    this.connection.on('VaultSnapshot', (items: VaultSnapshotItem[]) => {
      const metas = items.map(i => mapDocumentMeta(i as Record<string, unknown>))
      for (const l of this.snapshotListeners) l(metas)
    })

    this.connection.on('DocumentCreated', (evt: DocumentCreatedEvent) => {
      const meta = mapDocumentMeta(evt as Record<string, unknown>)
      for (const l of this.createdListeners) l(meta)
    })

    this.connection.on('DocumentRenamed', (evt: DocumentRenamedEvent) => {
      const documentId = str(evt.id ?? evt.Id)
      const newPath = str(evt.newPath ?? evt.NewPath)
      for (const l of this.renamedListeners) l(documentId, newPath)
    })

    this.connection.on('DocumentDeleted', (evt: DocumentDeletedEvent) => {
      const documentId = str(evt.id ?? evt.Id)
      for (const l of this.deletedListeners) l(documentId)
    })

    this.connection.onreconnected(async () => {
      if (!this.connection || !this.joinedVaultId) return
      await this.connection.invoke('JoinVault', this.joinedVaultId)
    })

    return this.connection
  }
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}
