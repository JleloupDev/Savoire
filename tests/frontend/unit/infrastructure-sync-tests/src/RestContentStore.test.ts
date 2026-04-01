// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import { describe, it, expect, vi } from 'vitest'
import { RestContentStore } from '@savoire/infrastructure-sync'

function makeResponse(ok: boolean, status: number, body: string | object = ''): Response {
  return {
    ok,
    status,
    text: async () => (typeof body === 'string' ? body : ''),
    json: async () => (typeof body === 'object' ? body : {}),
  } as unknown as Response
}

describe('RestContentStore', () => {
  it('readText calls GET on the correct URL', async () => {
    const fetchFn = vi.fn(async () => makeResponse(true, 200, '# My Note'))
    const store = new RestContentStore({ fetchFn })
    const content = await store.readText('v1', 'd1')
    expect(content).toBe('# My Note')
    expect(fetchFn).toHaveBeenCalledWith(
      '/api/v1/vaults/v1/documents/d1/content',
      expect.objectContaining({ method: 'GET' }),
    )
  })

  it('readText returns empty string on 404', async () => {
    const fetchFn = vi.fn(async () => makeResponse(false, 404))
    const store = new RestContentStore({ fetchFn })
    expect(await store.readText('v1', 'd1')).toBe('')
  })

  it('readText throws on server error', async () => {
    const fetchFn = vi.fn(async () => makeResponse(false, 500))
    const store = new RestContentStore({ fetchFn })
    await expect(store.readText('v1', 'd1')).rejects.toThrow('HTTP 500')
  })

  it('writeText calls PUT on the correct URL', async () => {
    const fetchFn = vi.fn(async () => makeResponse(true, 200))
    const store = new RestContentStore({ fetchFn })
    await store.writeText('v1', 'd1', '# Updated')
    expect(fetchFn).toHaveBeenCalledWith(
      '/api/v1/vaults/v1/documents/d1/content',
      expect.objectContaining({ method: 'PUT', body: '# Updated' }),
    )
  })

  it('writeText throws on server error', async () => {
    const fetchFn = vi.fn(async () => makeResponse(false, 403))
    const store = new RestContentStore({ fetchFn })
    await expect(store.writeText('v1', 'd1', 'content')).rejects.toThrow('HTTP 403')
  })

  it('URL-encodes vaultId and documentId', async () => {
    const fetchFn = vi.fn(async () => makeResponse(true, 200, ''))
    const store = new RestContentStore({ fetchFn })
    await store.readText('vault/1', 'doc/2')
    expect(fetchFn).toHaveBeenCalledWith(
      `/api/v1/vaults/${encodeURIComponent('vault/1')}/documents/${encodeURIComponent('doc/2')}/content`,
      expect.anything(),
    )
  })

  it('respects baseUrl', async () => {
    const fetchFn = vi.fn(async () => makeResponse(true, 200, 'content'))
    const store = new RestContentStore({ fetchFn, baseUrl: 'http://localhost:5000' })
    await store.readText('v1', 'd1')
    expect(fetchFn).toHaveBeenCalledWith(
      'http://localhost:5000/api/v1/vaults/v1/documents/d1/content',
      expect.anything(),
    )
  })

  it('sends Bearer token when provided', async () => {
    const fetchFn = vi.fn(async () => makeResponse(true, 200, 'content'))
    const store = new RestContentStore({ fetchFn, getToken: () => 'my-jwt' })
    await store.readText('v1', 'd1')
    const headers = (fetchFn.mock.calls[0][1] as RequestInit).headers as Record<string, string>
    expect(headers['Authorization']).toBe('Bearer my-jwt')
  })
})
