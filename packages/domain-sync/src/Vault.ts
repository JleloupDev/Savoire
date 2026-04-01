// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import { ConnectivityState, ReplicationMode } from './enums'
import type { DocumentId, DocumentMeta, VaultId } from './types'
import { Document } from './Document'
import { VaultSyncState } from './VaultSyncState'

function trimNonEmpty(value: string, label: string): string {
  const v = value.trim()
  if (!v) throw new Error(`${label} must not be empty`)
  return v
}

export class Vault {
  public readonly id: VaultId
  public name: string
  public replicationMode: ReplicationMode
  public connectivityState: ConnectivityState
  public readonly sync: VaultSyncState
  public readonly documents = new Map<DocumentId, Document>()

  constructor(params: {
    id: VaultId
    name: string
    replicationMode?: ReplicationMode
    connectivityState?: ConnectivityState
    sync?: VaultSyncState
    documents?: Document[]
  }) {
    this.id = params.id
    this.name = trimNonEmpty(params.name, 'name')
    this.replicationMode = params.replicationMode ?? ReplicationMode.Bidirectional
    this.connectivityState = params.connectivityState ?? ConnectivityState.Offline
    this.sync = params.sync ?? new VaultSyncState()
    for (const doc of params.documents ?? []) this.documents.set(doc.id, doc)
  }

  addDocument(document: Document): void {
    this.documents.set(document.id, document)
  }

  removeDocument(documentId: DocumentId): void {
    this.documents.delete(documentId)
  }

  getDocument(documentId: DocumentId): Document | undefined {
    return this.documents.get(documentId)
  }

  listDocuments(): DocumentMeta[] {
    return Array.from(this.documents.values())
      .map(d => d.toMeta())
      .sort((a, b) => a.path.localeCompare(b.path))
  }

  rename(newName: string): void {
    this.name = trimNonEmpty(newName, 'newName')
  }

  markOnline(): void {
    this.connectivityState = ConnectivityState.Online
  }

  markOffline(): void {
    this.connectivityState = ConnectivityState.Offline
  }

  markConnecting(): void {
    this.connectivityState = ConnectivityState.Connecting
  }

  markInSync(at: Date): void {
    this.sync.markInSync(at)
  }

  markSyncing(): void {
    this.sync.markSyncing()
  }

  markOutOfSync(reason: string): void {
    this.sync.markOutOfSync(reason)
  }

  markConflict(reason: string): void {
    this.sync.markConflict(reason)
  }

  markError(reason: string): void {
    this.sync.markError(reason)
  }
}
