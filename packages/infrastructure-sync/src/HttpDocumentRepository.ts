// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import type { Document, DocumentMeta, IDocumentRepository } from '@savoire/domain-sync'
import { HttpClient, type HttpClientOptions } from './http'
import { mapDocument, mapDocumentMeta } from './mappers'

export interface HttpDocumentRepositoryOptions extends HttpClientOptions {}

export class HttpDocumentRepository implements IDocumentRepository {
  private readonly http: HttpClient

  constructor(options: HttpDocumentRepositoryOptions = {}) {
    this.http = new HttpClient(options)
  }

  async listByVault(vaultId: string): Promise<DocumentMeta[]> {
    const list = await this.http.getJson<Record<string, unknown>[]>(`/api/v1/vaults/${encodeURIComponent(vaultId)}/documents`)
    return list.map(mapDocumentMeta)
  }

  async getById(vaultId: string, documentId: string): Promise<Document | undefined> {
    const docs = await this.http.getJson<Record<string, unknown>[]>(`/api/v1/vaults/${encodeURIComponent(vaultId)}/documents`)
    const found = docs.find(d => str(d.id ?? d.Id) === documentId)
    if (!found) return undefined
    const content = await this.http.getText(`/api/v1/vaults/${encodeURIComponent(vaultId)}/documents/${encodeURIComponent(documentId)}/content`)
    return mapDocument(found, content)
  }

  async getByPath(vaultId: string, path: string): Promise<Document | undefined> {
    const docs = await this.http.getJson<Record<string, unknown>[]>(`/api/v1/vaults/${encodeURIComponent(vaultId)}/documents`)
    const found = docs.find(d => str(d.path ?? d.Path) === path)
    if (!found) return undefined
    const docId = str(found.id ?? found.Id)
    const content = await this.http.getText(`/api/v1/vaults/${encodeURIComponent(vaultId)}/documents/${encodeURIComponent(docId)}/content`)
    return mapDocument(found, content)
  }

  async save(vaultId: string, document: Document): Promise<void> {
    await this.http.putText(
      `/api/v1/vaults/${encodeURIComponent(vaultId)}/documents/${encodeURIComponent(document.id)}/content`,
      document.content,
    )
    await this.http.patchJson(
      `/api/v1/vaults/${encodeURIComponent(vaultId)}/documents/${encodeURIComponent(document.id)}`,
      { path: document.path },
    )
  }

  async delete(vaultId: string, documentId: string): Promise<void> {
    await this.http.delete(`/api/v1/vaults/${encodeURIComponent(vaultId)}/documents/${encodeURIComponent(documentId)}`)
  }
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}
