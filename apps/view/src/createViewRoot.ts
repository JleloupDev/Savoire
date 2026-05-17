// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import { DocumentRoomClient, RestDocumentFetcher } from '@savoire/infrastructure-sync'
import type { VaultAPI } from '@savoire/plugin-api'

// ── DirectVaultAPI — VaultAPI minimale via REST ───────────────────────────────

export class DirectVaultAPI implements VaultAPI {
  private readonly fetcher: RestDocumentFetcher

  constructor(
    private readonly vaultId: string,
    private readonly token: string,
    private readonly docId: string,
    private readonly path: string,
    baseUrl?: string,
  ) {
    this.fetcher = new RestDocumentFetcher({ baseUrl: baseUrl ?? '' })
  }

  async read(documentId: string): Promise<string> {
    return this.fetcher.getDocumentContent(this.vaultId, documentId, this.token)
  }

  async readDocumentByPath(path: string): Promise<string> {
    const resolved = this.resolveDocumentId(path)
    if (!resolved) throw new Error(`Document not found for path: ${path}`)
    return this.read(resolved)
  }

  async write(documentId: string, content: string): Promise<void> {
    return this.fetcher.writeDocumentContent(this.vaultId, documentId, content, this.token)
  }

  async list(dir?: string): Promise<string[]> {
    const prefix = dir ? (dir.endsWith('/') ? dir : `${dir}/`) : ''
    return this.path.startsWith(prefix) ? [this.path] : []
  }

  async exists(documentId: string): Promise<boolean> {
    try { await this.read(documentId); return true } catch { return false }
  }

  resolveDocumentId(path: string): string | undefined {
    if (path === this.path) return this.docId
    if (!path.includes('.') && `${path}.md` === this.path) return this.docId
    return undefined
  }

  getVaultId(): string { return this.vaultId }
  getToken(): string   { return this.token }
}

// ── DocumentRoomClient factory ────────────────────────────────────────────────

export function createDocumentRoomClient(params: { serverUrl?: string; getToken: () => string }) {
  return new DocumentRoomClient({ serverUrl: params.serverUrl ?? '', getToken: params.getToken })
}
