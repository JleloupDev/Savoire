// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import type { IVaultRepository, Vault } from '@savoire/domain-sync'
import { HttpClient, type HttpClientOptions } from './http'
import { mapVault } from './mappers'

export interface HttpVaultRepositoryOptions extends HttpClientOptions {}

export class HttpVaultRepository implements IVaultRepository {
  private readonly http: HttpClient

  constructor(options: HttpVaultRepositoryOptions = {}) {
    this.http = new HttpClient(options)
  }

  async listByAccount(accountId: string): Promise<Vault[]> {
    const list = await this.http.getJson<Record<string, unknown>[]>(`/api/v1/users/${encodeURIComponent(accountId)}/vaults`)
    return list.map(mapVault)
  }

  async getById(vaultId: string): Promise<Vault | undefined> {
    try {
      const dto = await this.http.getJson<Record<string, unknown>>(`/api/v1/vaults/${encodeURIComponent(vaultId)}`)
      return mapVault(dto)
    } catch (err) {
      if (is404(err)) return undefined
      throw err
    }
  }

  async save(vault: Vault): Promise<void> {
    await this.http.patchJson(`/api/v1/vaults/${encodeURIComponent(vault.id)}`, { name: vault.name })
  }

  async delete(vaultId: string): Promise<void> {
    await this.http.delete(`/api/v1/vaults/${encodeURIComponent(vaultId)}`)
  }
}

function is404(err: unknown): boolean {
  return err instanceof Error && err.message.includes('404')
}
