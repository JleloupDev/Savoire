// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import type { DocumentStore, IDocumentMeta } from '@savoire/platform'
import type { IDocumentSessionAPI } from './contracts'

export class DocumentSessionService implements IDocumentSessionAPI {
  constructor(private readonly store: DocumentStore) {}

  async open(vaultId: string, docId: string, metadata: IDocumentMeta, token: string): Promise<string> {
    const opened = await this.store.open(vaultId, docId, metadata, token)
    return opened.content
  }

  close(vaultId: string, docId: string): void {
    this.store.close(vaultId, docId)
  }

  read(vaultId: string, docId: string, token: string): Promise<string> {
    return this.store.readContent(vaultId, docId, token)
  }
}
