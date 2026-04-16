// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
/**
 * DocumentStore — thin wrapper around IDocumentFetcher.
 * No in-memory cache: every read goes directly to the fetcher (CRDT ydoc or REST).
 *
 * TEMPORARY: the cache has been removed to fix stale embed content (embeds were
 * returning the first-loaded snapshot instead of live CRDT state). The proper
 * fix is a cache backed by an event bus: documents are cached on first load and
 * invalidated via CRDT update events (ReceiveOperation / document stabilized)
 * rather than being re-fetched on every read. This requires the DocumentStore
 * to subscribe to the CRDT event stream and evict or refresh affected entries.
 */

import type { IDocumentFetcher, IDocumentMeta } from './ports'

export interface OpenDocument {
  readonly docId: string
  readonly path: string
  readonly content: string
  readonly metadata: IDocumentMeta
  refCount: number
}

export class DocumentStore {
  constructor(
    private readonly fetcher: IDocumentFetcher,
    private readonly writer?: IDocumentFetcher,
  ) {}

  async open(vaultId: string, docId: string, metadata: IDocumentMeta, token: string): Promise<OpenDocument> {
    const content = await this.fetcher.getDocumentContent(vaultId, docId, token)
    return { docId, path: metadata.path, content, metadata, refCount: 1 }
  }

  async readContent(vaultId: string, docId: string, token: string, _metadata?: IDocumentMeta): Promise<string> {
    return this.fetcher.getDocumentContent(vaultId, docId, token)
  }

  /** Reads directly via the writer (REST) bypassing the CRDT fetcher. */
  async readDirect(vaultId: string, docId: string, token: string): Promise<string> {
    return (this.writer ?? this.fetcher).getDocumentContent(vaultId, docId, token)
  }

  async writeContent(vaultId: string, docId: string, content: string, token: string): Promise<void> {
    await (this.writer ?? this.fetcher).writeDocumentContent(vaultId, docId, content, token)
  }

  // No-ops retained for interface compatibility with DocumentSessionService.
  close(_vaultId: string, _docId: string): void {}

  get(_vaultId: string, _docId: string): OpenDocument | undefined { return undefined }

  get size(): number { return 0 }
}
