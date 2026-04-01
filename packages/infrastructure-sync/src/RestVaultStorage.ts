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

  async createDocument(vaultId: string, path: string, token: string): Promise<IDocumentMeta> {
    const res = await this.fetchFn(
      this.resolve(`/api/v1/vaults/${encodeURIComponent(vaultId)}/documents`),
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          path,
          title: path.split('/').at(-1)?.replace(/\.md$/i, '') ?? 'New note',
        }),
      },
    )
    if (!res.ok) throw new Error(`${res.status}`)
    return res.json() as Promise<IDocumentMeta>
  }

  async renameDocument(vaultId: string, docId: string, path: string, token: string): Promise<void> {
    const res = await this.fetchFn(
      this.resolve(`/api/v1/vaults/${encodeURIComponent(vaultId)}/documents/${encodeURIComponent(docId)}`),
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          path,
          title: path.split('/').at(-1)?.replace(/\.md$/i, '') ?? '',
        }),
      },
    )
    if (!res.ok) throw new Error(`${res.status}`)
  }

  async deleteDocument(vaultId: string, docId: string, token: string): Promise<void> {
    const res = await this.fetchFn(
      this.resolve(`/api/v1/vaults/${encodeURIComponent(vaultId)}/documents/${encodeURIComponent(docId)}`),
      { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } },
    )
    if (!res.ok && res.status !== 204) throw new Error(`${res.status}`)
  }

  async createFolder(vaultId: string, path: string, token: string): Promise<void> {
    const res = await this.fetchFn(
      this.resolve(`/api/v1/vaults/${encodeURIComponent(vaultId)}/folders`),
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ path }),
      },
    )
    if (!res.ok) throw new Error(`${res.status}`)
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

  async listFolders(vaultId: string, token: string): Promise<string[]> {
    const res = await this.fetchFn(
      this.resolve(`/api/v1/vaults/${encodeURIComponent(vaultId)}/folders`),
      { method: 'GET', headers: { Authorization: `Bearer ${token}` } },
    )
    if (!res.ok) throw new Error(`${res.status}`)
    const folders = await res.json() as Array<{ id: string; path: string }>
    return folders.map(f => f.path.endsWith('/') ? f.path : f.path + '/')
  }

  async deleteFolder(vaultId: string, path: string, token: string): Promise<void> {
    const listRes = await this.fetchFn(
      this.resolve(`/api/v1/vaults/${encodeURIComponent(vaultId)}/folders`),
      { method: 'GET', headers: { Authorization: `Bearer ${token}` } },
    )
    if (!listRes.ok) throw new Error(`${listRes.status}`)

    const folders = (await listRes.json()) as Array<{ id: string; path: string }>
    const normalized = path.replace(/\/$/, '')
    const folder = folders.find(f => f.path === path || f.path === normalized)
    if (!folder) return

    const delRes = await this.fetchFn(
      this.resolve(`/api/v1/vaults/${encodeURIComponent(vaultId)}/folders/${encodeURIComponent(folder.id)}`),
      { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } },
    )
    if (!delRes.ok && delRes.status !== 204) throw new Error(`${delRes.status}`)
  }

  private resolve(path: string): string {
    return this.baseUrl ? `${this.baseUrl}${path}` : path
  }
}
