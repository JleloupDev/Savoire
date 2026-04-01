// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import { describe, it, expect, vi } from 'vitest'
import { HttpClient } from '@savoire/infrastructure-sync'

function makeResponse(opts: { ok: boolean; status: number; body?: string | object }): Response {
  return {
    ok: opts.ok,
    status: opts.status,
    json: async () => (typeof opts.body === 'object' ? opts.body : {}),
    text: async () => (typeof opts.body === 'string' ? opts.body : ''),
  } as unknown as Response
}

describe('HttpClient', () => {
  it('getJson sends GET with content-type json and returns parsed body', async () => {
    const fetch = vi.fn(async () => makeResponse({ ok: true, status: 200, body: { id: '1' } }))
    const client = new HttpClient({ fetchFn: fetch })
    const result = await client.getJson('/api/vaults')
    expect(fetch).toHaveBeenCalledWith('/api/vaults', expect.objectContaining({ method: 'GET' }))
    expect(result).toEqual({ id: '1' })
  })

  it('getJson throws on non-ok response', async () => {
    const fetch = vi.fn(async () => makeResponse({ ok: false, status: 500 }))
    const client = new HttpClient({ fetchFn: fetch })
    await expect(client.getJson('/api/fail')).rejects.toThrow('HTTP 500')
  })

  it('postJson sends POST with JSON body', async () => {
    const fetch = vi.fn(async () => makeResponse({ ok: true, status: 201, body: { id: '2' } }))
    const client = new HttpClient({ fetchFn: fetch })
    await client.postJson('/api/vaults', { name: 'New' })
    expect(fetch).toHaveBeenCalledWith(
      '/api/vaults',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ name: 'New' }) }),
    )
  })

  it('patchJson sends PATCH with JSON body', async () => {
    const fetch = vi.fn(async () => makeResponse({ ok: true, status: 200, body: { id: '1' } }))
    const client = new HttpClient({ fetchFn: fetch })
    await client.patchJson('/api/vaults/1', { name: 'Updated' })
    expect(fetch).toHaveBeenCalledWith(
      '/api/vaults/1',
      expect.objectContaining({ method: 'PATCH' }),
    )
  })

  it('putText sends PUT with text/markdown content-type', async () => {
    const fetch = vi.fn(async () => makeResponse({ ok: true, status: 200 }))
    const client = new HttpClient({ fetchFn: fetch })
    await client.putText('/api/content', '# Hello')
    expect(fetch).toHaveBeenCalledWith(
      '/api/content',
      expect.objectContaining({ method: 'PUT', body: '# Hello' }),
    )
    const headers = (fetch.mock.calls[0][1] as RequestInit).headers as Record<string, string>
    expect(headers['Content-Type']).toBe('text/markdown')
  })

  it('putText throws on non-ok response', async () => {
    const fetch = vi.fn(async () => makeResponse({ ok: false, status: 403 }))
    const client = new HttpClient({ fetchFn: fetch })
    await expect(client.putText('/api/content', 'x')).rejects.toThrow('HTTP 403')
  })

  it('getText returns empty string on 404', async () => {
    const fetch = vi.fn(async () => makeResponse({ ok: false, status: 404 }))
    const client = new HttpClient({ fetchFn: fetch })
    const result = await client.getText('/api/content')
    expect(result).toBe('')
  })

  it('getText returns text body on success', async () => {
    const fetch = vi.fn(async () => makeResponse({ ok: true, status: 200, body: '# Note content' }))
    const client = new HttpClient({ fetchFn: fetch })
    const result = await client.getText('/api/content')
    expect(result).toBe('# Note content')
  })

  it('getText throws on non-ok non-404 response', async () => {
    const fetch = vi.fn(async () => makeResponse({ ok: false, status: 500 }))
    const client = new HttpClient({ fetchFn: fetch })
    await expect(client.getText('/api/content')).rejects.toThrow('HTTP 500')
  })

  it('delete sends DELETE request', async () => {
    const fetch = vi.fn(async () => makeResponse({ ok: true, status: 200 }))
    const client = new HttpClient({ fetchFn: fetch })
    await client.delete('/api/vaults/1')
    expect(fetch).toHaveBeenCalledWith(
      '/api/vaults/1',
      expect.objectContaining({ method: 'DELETE' }),
    )
  })

  it('delete treats 204 as success', async () => {
    const fetch = vi.fn(async () => makeResponse({ ok: false, status: 204 }))
    const client = new HttpClient({ fetchFn: fetch })
    await expect(client.delete('/api/vaults/1')).resolves.toBeUndefined()
  })

  it('delete throws on non-ok non-204 response', async () => {
    const fetch = vi.fn(async () => makeResponse({ ok: false, status: 403 }))
    const client = new HttpClient({ fetchFn: fetch })
    await expect(client.delete('/api/vaults/1')).rejects.toThrow('HTTP 403')
  })

  it('includes Authorization header when token is provided', async () => {
    const fetch = vi.fn(async () => makeResponse({ ok: true, status: 200, body: {} }))
    const client = new HttpClient({ fetchFn: fetch, getToken: () => 'my-token' })
    await client.getJson('/api/vaults')
    const headers = (fetch.mock.calls[0][1] as RequestInit).headers as Record<string, string>
    expect(headers['Authorization']).toBe('Bearer my-token')
  })

  it('omits Authorization header when no token', async () => {
    const fetch = vi.fn(async () => makeResponse({ ok: true, status: 200, body: {} }))
    const client = new HttpClient({ fetchFn: fetch, getToken: () => null })
    await client.getJson('/api/vaults')
    const headers = (fetch.mock.calls[0][1] as RequestInit).headers as Record<string, string>
    expect(headers['Authorization']).toBeUndefined()
  })

  it('prepends baseUrl to path', async () => {
    const fetch = vi.fn(async () => makeResponse({ ok: true, status: 200, body: {} }))
    const client = new HttpClient({ fetchFn: fetch, baseUrl: 'http://localhost:5000' })
    await client.getJson('/api/vaults')
    expect(fetch).toHaveBeenCalledWith('http://localhost:5000/api/vaults', expect.anything())
  })

  it('uses path directly when baseUrl is empty', async () => {
    const fetch = vi.fn(async () => makeResponse({ ok: true, status: 200, body: {} }))
    const client = new HttpClient({ fetchFn: fetch, baseUrl: '' })
    await client.getJson('/api/vaults')
    expect(fetch).toHaveBeenCalledWith('/api/vaults', expect.anything())
  })

  it('getToken returning undefined omits Authorization header', async () => {
    const fetch = vi.fn(async () => makeResponse({ ok: true, status: 200, body: {} }))
    const client = new HttpClient({ fetchFn: fetch, getToken: () => undefined })
    await client.getJson('/api/test')
    const headers = (fetch.mock.calls[0][1] as RequestInit).headers as Record<string, string>
    expect(headers['Authorization']).toBeUndefined()
  })
})
