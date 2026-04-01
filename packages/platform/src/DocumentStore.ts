// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
/**
 * DocumentStore — gestion des documents ouverts en mémoire.
 *
 */

import type { IDocumentFetcher, IDocumentMeta } from './ports'

export interface OpenDocument {
  readonly docId: string
  readonly path: string
  readonly content: string
  readonly metadata: IDocumentMeta
  refCount: number
}

function key(vaultId: string, docId: string): string {
  return `${vaultId}/${docId}`
}

export class DocumentStore {
 // Cache of documents opened in the editor (key = `${vaultId}/${docId}`).
  private readonly cache = new Map<string, OpenDocument>()
  private readonly pending = new Map<string, Promise<OpenDocument>>()

  constructor(
    private readonly fetcher: IDocumentFetcher,
    private readonly writer?: IDocumentFetcher,
  ) {}

  async open(vaultId: string, docId: string, metadata: IDocumentMeta, token: string): Promise<OpenDocument> {
    const doc = await this.ensureCached(vaultId, docId, metadata, token)
    doc.refCount++
    return doc
  }

  /**
   * Lit le contenu d'un document sans modifier le refCount.
   * - Si le document est déjà en cache (ouvert dans l'éditeur) : retourne le contenu en mémoire.
   * - Sinon :
   *   - avec metadata : charge et garde en cache "passif" (refCount=0), utile pour les embeds.
   *   - sans metadata : charge via le fetcher sans cache durable.
   *
   * see ADR-010
   */
  async readContent(vaultId: string, docId: string, token: string, metadata?: IDocumentMeta): Promise<string> {
    const k = key(vaultId, docId)
    const cached = this.cache.get(k)
    if (cached) {
      // Keep authoritative cache only for actively opened docs.
      if (cached.refCount > 0) return cached.content
      // Passive empty cache is often transient (404/content not yet available).
      if (cached.content !== '') return cached.content
      this.cache.delete(k)
    }
    if (metadata) {
      const loaded = await this.ensureCached(vaultId, docId, metadata, token)
      if (loaded.refCount === 0 && loaded.content === '') {
        this.cache.delete(k)
      }
      return loaded.content
    }
    return this.fetcher.getDocumentContent(vaultId, docId, token)
  }

  /** Lit directement via le writer (REST) sans passer par le CRDT. */
  async readDirect(vaultId: string, docId: string, token: string): Promise<string> {
    return (this.writer ?? this.fetcher).getDocumentContent(vaultId, docId, token)
  }

  async writeContent(vaultId: string, docId: string, content: string, token: string): Promise<void> {
    await (this.writer ?? this.fetcher).writeDocumentContent(vaultId, docId, content, token)
    // Update cache if doc is cached
    const k = key(vaultId, docId)
    const cached = this.cache.get(k)
    if (cached) (cached as { content: string }).content = content
  }

  close(vaultId: string, docId: string): void {
    const k = key(vaultId, docId)
    const doc = this.cache.get(k)
    if (!doc) return
    doc.refCount--
    if (doc.refCount <= 0) this.cache.delete(k)
  }

  get(vaultId: string, docId: string): OpenDocument | undefined {
    return this.cache.get(key(vaultId, docId))
  }

  get size(): number {
    return this.cache.size
  }

  private async ensureCached(vaultId: string, docId: string, metadata: IDocumentMeta, token: string): Promise<OpenDocument> {
    const k = key(vaultId, docId)
    const cached = this.cache.get(k)
    if (cached) return cached

    const pending = this.pending.get(k)
    if (pending) return pending

    const request = (async () => {
      try {
        const content = await this.fetcher.getDocumentContent(vaultId, docId, token)
        const doc: OpenDocument = { docId, path: metadata.path, content, metadata, refCount: 0 }
        this.cache.set(k, doc)
        return doc
      } finally {
        this.pending.delete(k)
      }
    })()

    this.pending.set(k, request)
    return request
  }
}
