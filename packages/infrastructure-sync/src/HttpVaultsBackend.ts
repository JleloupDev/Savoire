// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import type { AppDocumentSummary, AppVaultSummary, AppWorkspace, IVaultsBackend } from '@savoire/application'

export interface HttpVaultsBackendOptions {
  baseUrl?: string
  fetchFn?: typeof fetch
}

export class HttpVaultsBackend implements IVaultsBackend {
  private readonly baseUrl: string
  private readonly fetchFn: typeof fetch

  constructor(options: HttpVaultsBackendOptions = {}) {
    this.baseUrl = options.baseUrl ?? ''
    this.fetchFn = options.fetchFn ?? globalThis.fetch.bind(globalThis)
  }

  listVaults(userId: string, token: string): Promise<AppWorkspace> {
    return this.requestJson<AppWorkspace>(
      `/api/v1/users/${encodeURIComponent(userId)}/vaults`,
      token,
      { method: 'GET' },
    )
  }

  createVault(userId: string, name: string, token: string): Promise<AppVaultSummary> {
    return this.requestJson<AppVaultSummary>(
      `/api/v1/users/${encodeURIComponent(userId)}/vaults`,
      token,
      { method: 'POST', body: JSON.stringify({ name }) },
    )
  }

  renameVault(vaultId: string, name: string, token: string): Promise<AppVaultSummary> {
    return this.requestJson<AppVaultSummary>(
      `/api/v1/vaults/${encodeURIComponent(vaultId)}`,
      token,
      { method: 'PATCH', body: JSON.stringify({ name }) },
    )
  }

  deleteVault(vaultId: string, token: string): Promise<void> {
    return this.requestJson<void>(
      `/api/v1/vaults/${encodeURIComponent(vaultId)}`,
      token,
      { method: 'DELETE' },
    )
  }

  listDocuments(vaultId: string, token: string): Promise<AppDocumentSummary[]> {
    return this.requestJson<AppDocumentSummary[]>(
      `/api/v1/vaults/${encodeURIComponent(vaultId)}/documents`,
      token,
      { method: 'GET' },
    ).then(list => list.map(d => ({ id: d.id, path: d.path })))
  }


  private async requestJson<T>(path: string, token: string, init: RequestInit): Promise<T> {
    const res = await this.fetchFn(this.resolve(path), {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        ...(init.headers ?? {}),
      },
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Error(`${res.status}: ${body}`)
    }
    if (res.status === 204) return undefined as T
    return res.json() as Promise<T>
  }

  private resolve(path: string): string {
    return this.baseUrl ? `${this.baseUrl}${path}` : path
  }
}
