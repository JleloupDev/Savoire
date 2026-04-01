// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import type { IContentStore } from '@savoire/domain-sync'
import { HttpClient, type HttpClientOptions } from './http'

export interface RestContentStoreOptions extends HttpClientOptions {}

export class RestContentStore implements IContentStore {
  private readonly http: HttpClient

  constructor(options: RestContentStoreOptions = {}) {
    this.http = new HttpClient(options)
  }

  readText(vaultId: string, documentId: string): Promise<string> {
    return this.http.getText(`/api/v1/vaults/${encodeURIComponent(vaultId)}/documents/${encodeURIComponent(documentId)}/content`)
  }

  writeText(vaultId: string, documentId: string, content: string): Promise<void> {
    return this.http.putText(`/api/v1/vaults/${encodeURIComponent(vaultId)}/documents/${encodeURIComponent(documentId)}/content`, content)
  }
}
