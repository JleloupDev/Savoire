// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import { describe, it, expect, vi } from 'vitest'
import { HttpAccountRepository } from '@savoire/infrastructure-sync'

function makeResponse(opts: { ok: boolean; status: number; body?: object }): Response {
  return {
    ok: opts.ok,
    status: opts.status,
    json: async () => opts.body ?? {},
    text: async () => '',
  } as unknown as Response
}

describe('HttpAccountRepository', () => {
  it('getById returns Account on success with camelCase DTO', async () => {
    const fetchFn = vi.fn(async () =>
      makeResponse({ ok: true, status: 200, body: { id: 'u1', displayName: 'Alice', email: 'alice@example.com' } }),
    )
    const repo = new HttpAccountRepository({ fetchFn })
    const account = await repo.getById('u1')
    expect(account).toBeDefined()
    expect(account!.id).toBe('u1')
    expect(account!.displayName).toBe('Alice')
    expect(account!.email).toBe('alice@example.com')
    expect(fetchFn).toHaveBeenCalledWith('/api/v1/users/u1', expect.anything())
  })

  it('getById returns Account on success with PascalCase DTO', async () => {
    const fetchFn = vi.fn(async () =>
      makeResponse({ ok: true, status: 200, body: { Id: 'u2', DisplayName: 'Bob', Email: 'bob@example.com' } }),
    )
    const repo = new HttpAccountRepository({ fetchFn })
    const account = await repo.getById('u2')
    expect(account!.id).toBe('u2')
    expect(account!.displayName).toBe('Bob')
    expect(account!.email).toBe('bob@example.com')
  })

  it('getById returns undefined on 404', async () => {
    const fetchFn = vi.fn(async () => makeResponse({ ok: false, status: 404 }))
    const repo = new HttpAccountRepository({ fetchFn })
    const account = await repo.getById('missing')
    expect(account).toBeUndefined()
  })

  it('getById throws on non-404 errors', async () => {
    const fetchFn = vi.fn(async () => makeResponse({ ok: false, status: 500 }))
    const repo = new HttpAccountRepository({ fetchFn })
    await expect(repo.getById('u1')).rejects.toThrow('HTTP 500')
  })

  it('getById URL-encodes account id with special characters', async () => {
    const fetchFn = vi.fn(async () =>
      makeResponse({ ok: true, status: 200, body: { id: 'user@domain', displayName: 'Test', email: 'test@domain.com' } }),
    )
    const repo = new HttpAccountRepository({ fetchFn })
    await repo.getById('user@domain')
    expect(fetchFn).toHaveBeenCalledWith(
      `/api/v1/users/${encodeURIComponent('user@domain')}`,
      expect.anything(),
    )
  })

  it('save throws NotSupported error', async () => {
    const repo = new HttpAccountRepository()
    const { Account } = await import('@savoire/domain-sync')
    const account = new Account({ id: 'u1', displayName: 'User', email: 'u@example.com' })
    await expect(repo.save(account)).rejects.toThrow('not supported')
  })
})
