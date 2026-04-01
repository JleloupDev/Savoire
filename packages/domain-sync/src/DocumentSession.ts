// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import { ConnectivityState, ReplicationMode, SyncState, UpdateSource } from './enums'
import type { DocumentId, DocumentUpdate, VaultId } from './types'

function assertDocId(expected: string, actual: string): void {
  if (expected !== actual) {
    throw new Error(`Document id mismatch: expected ${expected}, got ${actual}`)
  }
}

export class DocumentSession {
  public readonly sessionId: string
  public readonly documentId: DocumentId
  public readonly vaultId: VaultId
  public replicationMode: ReplicationMode
  public syncState: SyncState
  public connectivityState: ConnectivityState
  public version: number
  public readonly pendingLocalUpdates: DocumentUpdate[]
  public readonly appliedRemoteUpdateIds: Set<string>

  constructor(params: {
    sessionId: string
    documentId: DocumentId
    vaultId: VaultId
    replicationMode?: ReplicationMode
    syncState?: SyncState
    connectivityState?: ConnectivityState
    version?: number
    pendingLocalUpdates?: DocumentUpdate[]
    appliedRemoteUpdateIds?: Iterable<string>
  }) {
    this.sessionId = params.sessionId
    this.documentId = params.documentId
    this.vaultId = params.vaultId
    this.replicationMode = params.replicationMode ?? ReplicationMode.Bidirectional
    this.syncState = params.syncState ?? SyncState.NotInitialized
    this.connectivityState = params.connectivityState ?? ConnectivityState.Offline
    this.version = params.version ?? 0
    this.pendingLocalUpdates = [...(params.pendingLocalUpdates ?? [])]
    this.appliedRemoteUpdateIds = new Set(params.appliedRemoteUpdateIds ?? [])
  }

  applyLocalUpdate(update: DocumentUpdate): void {
    assertDocId(this.documentId, update.documentId)
    if (update.source !== UpdateSource.Local) {
      throw new Error('applyLocalUpdate expects a local update')
    }
    this.pendingLocalUpdates.push(update)
    this.version += 1
    this.syncState = SyncState.LocalPending
  }

  applyRemoteUpdate(update: DocumentUpdate): void {
    assertDocId(this.documentId, update.documentId)
    if (update.source !== UpdateSource.Remote) {
      throw new Error('applyRemoteUpdate expects a remote update')
    }
    if (this.appliedRemoteUpdateIds.has(update.updateId)) return
    this.appliedRemoteUpdateIds.add(update.updateId)
    this.version += 1
    if (this.pendingLocalUpdates.length === 0) this.syncState = SyncState.InSync
  }

  ackLocalUpdate(updateId: string): void {
    const idx = this.pendingLocalUpdates.findIndex(u => u.updateId === updateId)
    if (idx === -1) return
    this.pendingLocalUpdates.splice(idx, 1)
    if (this.pendingLocalUpdates.length === 0) this.syncState = SyncState.InSync
  }

  markConnected(): void {
    this.connectivityState = ConnectivityState.Online
  }

  markDisconnected(): void {
    this.connectivityState = ConnectivityState.Offline
  }

  markConnecting(): void {
    this.connectivityState = ConnectivityState.Connecting
  }

  markConflict(): void {
    this.syncState = SyncState.Conflict
  }

  markError(): void {
    this.syncState = SyncState.Error
  }

  isDirty(): boolean {
    return this.pendingLocalUpdates.length > 0
  }
}
