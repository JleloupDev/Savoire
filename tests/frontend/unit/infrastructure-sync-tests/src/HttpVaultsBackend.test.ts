// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import { describe, it, expect, vi } from 'vitest'
import { HttpVaultsBackend } from '@savoire/infrastructure-sync'

function makeFetch(status: number, body: unknown = null) {
  return vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => (body ? JSON.stringify(body) : ''),
  }))
}

describe('HttpVaultsBackend', () => {
  it('listVaults calls GET /api/v1/users/:userId/vaults', async () => {
    const data = [{ id: 'v1', name: 'My Vault' }]
    const fetchFn = makeFetch(200, data)
    const backend = new HttpVaultsBackend({ fetchFn: fetchFn as never })
    const result = await backend.listVaults('user-1', 'tok')
    expect(result).toEqual(data)
    expect(fetchFn).toHaveBeenCalledWith(
      '/api/v1/users/user-1/vaults',
      expect.objectContaining({ method: 'GET' }),
    )
  })

  it('createVault calls POST with name body', async () => {
    const vault = { id: 'v2', name: 'New Vault' }
    const fetchFn = makeFetch(201, vault)
    const backend = new HttpVaultsBackend({ fetchFn: fetchFn as never })
    const result = await backend.createVault('user-1', 'New Vault', 'tok')
    expect(result).toEqual(vault)
    expect(fetchFn).toHaveBeenCalledWith(
      '/api/v1/users/user-1/vaults',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ name: 'New Vault' }) }),
    )
  })

  it('renameVault calls PATCH /api/v1/vaults/:vaultId', async () => {
    const vault = { id: 'v1', name: 'Renamed' }
    const fetchFn = makeFetch(200, vault)
    const backend = new HttpVaultsBackend({ fetchFn: fetchFn as never })
    const result = await backend.renameVault('v1', 'Renamed', 'tok')
    expect(result).toEqual(vault)
    expect(fetchFn).toHaveBeenCalledWith(
      '/api/v1/vaults/v1',
      expect.objectContaining({ method: 'PATCH' }),
    )
  })

  it('deleteVault calls DELETE and handles 204', async () => {
    const fetchFn = vi.fn(async () => ({ ok: true, status: 204, json: async () => undefined, text: async () => '' }))
    const backend = new HttpVaultsBackend({ fetchFn: fetchFn as never })
    await expect(backend.deleteVault('v1', 'tok')).resolves.toBeUndefined()
    expect(fetchFn).toHaveBeenCalledWith(
      '/api/v1/vaults/v1',
      expect.objectContaining({ method: 'DELETE' }),
    )
  })

  it('throws on HTTP error status', async () => {
    const fetchFn = vi.fn(async () => ({ ok: false, status: 403, json: async () => null, text: async () => 'Forbidden' }))
    const backend = new HttpVaultsBackend({ fetchFn: fetchFn as never })
    await expect(backend.listVaults('user-1', 'tok')).rejects.toThrow('403')
  })

  it('sends Authorization header with Bearer token', async () => {
    const fetchFn = makeFetch(200, [])
    const backend = new HttpVaultsBackend({ fetchFn: fetchFn as never })
    await backend.listVaults('user-1', 'my-token')
    expect(fetchFn).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer my-token' }),
      }),
    )
  })

  it('prepends baseUrl when provided', async () => {
    const fetchFn = makeFetch(200, [])
    const backend = new HttpVaultsBackend({ baseUrl: 'http://api.host', fetchFn: fetchFn as never })
    await backend.listVaults('user-1', 'tok')
    expect(fetchFn).toHaveBeenCalledWith(
      expect.stringContaining('http://api.host'),
      expect.anything(),
    )
  })

  it('URL-encodes userId with special characters', async () => {
    const fetchFn = makeFetch(200, [])
    const backend = new HttpVaultsBackend({ fetchFn: fetchFn as never })
    await backend.listVaults('user/1', 'tok')
    expect(fetchFn).toHaveBeenCalledWith(
      expect.stringContaining('user%2F1'),
      expect.anything(),
    )
  })
})
