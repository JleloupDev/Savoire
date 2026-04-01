// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import { describe, it, expect, vi } from 'vitest'
import { HttpVaultRepository } from '@savoire/infrastructure-sync'

function makeResponse(opts: { ok: boolean; status: number; body?: unknown }): Response {
  return {
    ok: opts.ok,
    status: opts.status,
    json: async () => opts.body ?? {},
    text: async () => '',
  } as unknown as Response
}

describe('HttpVaultRepository', () => {
  it('listByAccount returns mapped vaults', async () => {
    const fetchFn = vi.fn(async () =>
      makeResponse({ ok: true, status: 200, body: [{ id: 'v1', name: 'Main' }, { id: 'v2', name: 'Work' }] }),
    )
    const repo = new HttpVaultRepository({ fetchFn })
    const vaults = await repo.listByAccount('u1')
    expect(vaults).toHaveLength(2)
    expect(vaults[0].id).toBe('v1')
    expect(vaults[1].name).toBe('Work')
    expect(fetchFn).toHaveBeenCalledWith('/api/v1/users/u1/vaults', expect.anything())
  })

  it('listByAccount returns empty array when no vaults', async () => {
    const fetchFn = vi.fn(async () => makeResponse({ ok: true, status: 200, body: [] }))
    const repo = new HttpVaultRepository({ fetchFn })
    const vaults = await repo.listByAccount('u1')
    expect(vaults).toEqual([])
  })

  it('getById returns mapped vault on success', async () => {
    const fetchFn = vi.fn(async () =>
      makeResponse({ ok: true, status: 200, body: { id: 'v1', name: 'Main' } }),
    )
    const repo = new HttpVaultRepository({ fetchFn })
    const vault = await repo.getById('v1')
    expect(vault).toBeDefined()
    expect(vault!.id).toBe('v1')
    expect(vault!.name).toBe('Main')
  })

  it('getById returns undefined on 404', async () => {
    const fetchFn = vi.fn(async () => makeResponse({ ok: false, status: 404 }))
    const repo = new HttpVaultRepository({ fetchFn })
    const vault = await repo.getById('missing')
    expect(vault).toBeUndefined()
  })

  it('getById throws on non-404 errors', async () => {
    const fetchFn = vi.fn(async () => makeResponse({ ok: false, status: 500 }))
    const repo = new HttpVaultRepository({ fetchFn })
    await expect(repo.getById('v1')).rejects.toThrow('HTTP 500')
  })

  it('save calls PATCH with vault name', async () => {
    const fetchFn = vi.fn(async () => makeResponse({ ok: true, status: 200, body: {} }))
    const repo = new HttpVaultRepository({ fetchFn })
    const { Vault } = await import('@savoire/domain-sync')
    const vault = new Vault({ id: 'v1', name: 'Renamed' })
    await repo.save(vault)
    expect(fetchFn).toHaveBeenCalledWith(
      '/api/v1/vaults/v1',
      expect.objectContaining({ method: 'PATCH' }),
    )
  })

  it('delete calls DELETE on vault endpoint', async () => {
    const fetchFn = vi.fn(async () => makeResponse({ ok: true, status: 200 }))
    const repo = new HttpVaultRepository({ fetchFn })
    await repo.delete('v1')
    expect(fetchFn).toHaveBeenCalledWith('/api/v1/vaults/v1', expect.objectContaining({ method: 'DELETE' }))
  })

  it('listByAccount URL-encodes accountId', async () => {
    const fetchFn = vi.fn(async () => makeResponse({ ok: true, status: 200, body: [] }))
    const repo = new HttpVaultRepository({ fetchFn })
    await repo.listByAccount('user@domain')
    expect(fetchFn).toHaveBeenCalledWith(
      `/api/v1/users/${encodeURIComponent('user@domain')}/vaults`,
      expect.anything(),
    )
  })

  it('getById with PascalCase DTO maps correctly', async () => {
    const fetchFn = vi.fn(async () =>
      makeResponse({ ok: true, status: 200, body: { Id: 'v-pascal', Name: 'PascalVault' } }),
    )
    const repo = new HttpVaultRepository({ fetchFn })
    const vault = await repo.getById('v-pascal')
    expect(vault!.id).toBe('v-pascal')
    expect(vault!.name).toBe('PascalVault')
  })
})
