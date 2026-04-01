// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import { Account, type IAccountRepository } from '@savoire/domain-sync'
import { HttpClient, type HttpClientOptions } from './http'

export interface HttpAccountRepositoryOptions extends HttpClientOptions {}

export class HttpAccountRepository implements IAccountRepository {
  private readonly http: HttpClient

  constructor(options: HttpAccountRepositoryOptions = {}) {
    this.http = new HttpClient(options)
  }

  async getById(accountId: string): Promise<Account | undefined> {
    try {
      const dto = await this.http.getJson<Record<string, unknown>>(`/api/v1/users/${encodeURIComponent(accountId)}`)
      return new Account({
        id: str(dto.id ?? dto.Id),
        displayName: str(dto.displayName ?? dto.DisplayName),
        email: str(dto.email ?? dto.Email),
      })
    } catch (err) {
      if (is404(err)) return undefined
      throw err
    }
  }

  async save(_account: Account): Promise<void> {
    throw new Error('HttpAccountRepository.save is not supported by current API contracts')
  }
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function is404(err: unknown): boolean {
  return err instanceof Error && err.message.includes('404')
}
