// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import type { IDocumentMeta, IVaultStorage } from '@savoire/platform'

export interface RestVaultStorageOptions {
  baseUrl?: string
  fetchFn?: typeof fetch
}

export class RestVaultStorage implements IVaultStorage {
  private readonly baseUrl: string
  private readonly fetchFn: typeof fetch

  constructor(options: RestVaultStorageOptions = {}) {
    this.baseUrl = options.baseUrl ?? ''
    this.fetchFn = options.fetchFn ?? globalThis.fetch.bind(globalThis)
  }

  async readFile(vaultId: string, path: string, token: string): Promise<string> {
    const res = await this.fetchFn(
      this.resolve(`/api/v1/vaults/${encodeURIComponent(vaultId)}/attachments/${encodeURIComponent(path)}`),
      { method: 'GET', headers: { Authorization: `Bearer ${token}` } },
    )
    if (!res.ok) throw new Error(`${res.status}`)
    return res.text()
  }

  async writeFile(vaultId: string, path: string, content: string, token: string): Promise<void> {
    const blob = new Blob([content], { type: 'text/markdown' })
    const file = new File([blob], path.split('/').at(-1) ?? 'file.md', { type: 'text/markdown' })
    const form = new FormData()
    form.append('file', file)

    const res = await this.fetchFn(
      this.resolve(`/api/v1/vaults/${encodeURIComponent(vaultId)}/attachments`),
      { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form },
    )
    if (!res.ok) throw new Error(`${res.status}`)
  }

  resolveFileUrl(vaultId: string, path: string): string {
    return this.resolve(`/api/v1/vaults/${encodeURIComponent(vaultId)}/attachments/${encodeURIComponent(path)}`)
  }

  async listDocuments(vaultId: string, token: string): Promise<IDocumentMeta[]> {
    const res = await this.fetchFn(
      this.resolve(`/api/v1/vaults/${encodeURIComponent(vaultId)}/documents`),
      { method: 'GET', headers: { Authorization: `Bearer ${token}` } },
    )
    if (!res.ok) throw new Error(`${res.status}`)
    return res.json() as Promise<IDocumentMeta[]>
  }

  // These three are always overridden by DocumentsService.activateVault (VaultHub delegate).
  // The REST endpoints they used to call no longer exist.
  createDocument(): Promise<IDocumentMeta> {
    throw new Error('createDocument must go through VaultHub — use DocumentsService.activateVault')
  }

  renameDocument(): Promise<void> {
    throw new Error('renameDocument must go through VaultHub — use DocumentsService.activateVault')
  }

  deleteDocument(): Promise<void> {
    throw new Error('deleteDocument must go through VaultHub — use DocumentsService.activateVault')
  }

  async uploadAttachment(vaultId: string, file: File, token: string): Promise<{ fileName: string; storagePath: string }> {
    const form = new FormData()
    form.append('file', file)
    const res = await this.fetchFn(
      this.resolve(`/api/v1/vaults/${encodeURIComponent(vaultId)}/attachments`),
      { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form },
    )
    if (!res.ok) throw new Error(`${res.status}`)
    const dto = await res.json() as { fileName: string; path: string }
    return { fileName: dto.fileName, storagePath: dto.path }
  }

  private resolve(path: string): string {
    return this.baseUrl ? `${this.baseUrl}${path}` : path
  }
}
