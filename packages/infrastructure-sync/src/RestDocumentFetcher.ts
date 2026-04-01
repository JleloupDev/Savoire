// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import type { IDocumentFetcher } from '@savoire/platform'

export interface RestDocumentFetcherOptions {
  baseUrl?: string
  fetchFn?: typeof fetch
}

export class RestDocumentFetcher implements IDocumentFetcher {
  private readonly baseUrl: string
  private readonly fetchFn: typeof fetch

  constructor(options: RestDocumentFetcherOptions = {}) {
    this.baseUrl = options.baseUrl ?? ''
    this.fetchFn = options.fetchFn ?? globalThis.fetch.bind(globalThis)
  }

  async getDocumentContent(vaultId: string, docId: string, token: string): Promise<string> {
    const res = await this.fetchFn(
      this.resolve(`/api/v1/vaults/${encodeURIComponent(vaultId)}/documents/${encodeURIComponent(docId)}/content`),
      { method: 'GET', headers: { Authorization: `Bearer ${token}` } },
    )
    if (res.status === 404) return ''
    if (!res.ok) throw new Error(`${res.status}`)
    return res.text()
  }

  async writeDocumentContent(vaultId: string, docId: string, content: string, token: string): Promise<void> {
    const res = await this.fetchFn(
      this.resolve(`/api/v1/vaults/${encodeURIComponent(vaultId)}/documents/${encodeURIComponent(docId)}/content`),
      {
        method: 'PUT',
        headers: { 'Content-Type': 'text/plain', Authorization: `Bearer ${token}` },
        body: content,
      },
    )
    if (!res.ok) throw new Error(`${res.status}`)
  }

  private resolve(path: string): string {
    return this.baseUrl ? `${this.baseUrl}${path}` : path
  }
}
