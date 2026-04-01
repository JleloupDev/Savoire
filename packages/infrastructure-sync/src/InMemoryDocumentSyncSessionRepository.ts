// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import type { DocumentSession, IDocumentSyncSessionRepository } from '@savoire/domain-sync'

function key(vaultId: string, documentId: string): string {
  return `${vaultId}:${documentId}`
}

export class InMemoryDocumentSyncSessionRepository implements IDocumentSyncSessionRepository {
  private readonly sessions = new Map<string, DocumentSession>()

  async get(vaultId: string, documentId: string): Promise<DocumentSession | undefined> {
    return this.sessions.get(key(vaultId, documentId))
  }

  async save(session: DocumentSession): Promise<void> {
    this.sessions.set(key(session.vaultId, session.documentId), session)
  }

  async remove(vaultId: string, documentId: string): Promise<void> {
    this.sessions.delete(key(vaultId, documentId))
  }
}
