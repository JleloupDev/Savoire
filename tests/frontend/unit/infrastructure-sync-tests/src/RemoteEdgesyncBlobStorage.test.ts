// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import { describe, it, expect, vi, afterEach } from 'vitest'
import { RemoteEdgesyncBlobStorage } from '@savoire/infrastructure-sync'

function mockFetch(body: unknown, status = 200) {
  return vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  }))
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('RemoteEdgesyncBlobStorage', () => {
  it('get() decodes the base64 body into bytes', async () => {
    vi.stubGlobal('fetch', mockFetch({ bytesBase64: 'AQIDBAU=' }))
    const storage = new RemoteEdgesyncBlobStorage({ vaultId: 'v1', getToken: () => 'tok' })

    const bytes = await storage.get('open/content/abcd')
    expect(bytes).toEqual(new Uint8Array([1, 2, 3, 4, 5]))
  })

  it('get() returns undefined on 404', async () => {
    vi.stubGlobal('fetch', mockFetch(undefined, 404))
    const storage = new RemoteEdgesyncBlobStorage({ vaultId: 'v1', getToken: () => 'tok' })

    expect(await storage.get('open/content/missing')).toBeUndefined()
  })

  it('get() throws on other HTTP errors', async () => {
    vi.stubGlobal('fetch', mockFetch({ error: 'nope' }, 500))
    const storage = new RemoteEdgesyncBlobStorage({ vaultId: 'v1', getToken: () => 'tok' })

    await expect(storage.get('open/peers')).rejects.toThrow('500')
  })

  it('get() never calls fetch for secret/* keys — returns undefined', async () => {
    const fetch = mockFetch({ bytesBase64: 'AQ==' })
    vi.stubGlobal('fetch', fetch)
    const storage = new RemoteEdgesyncBlobStorage({ vaultId: 'v1', getToken: () => 'tok' })

    expect(await storage.get('secret/keyring')).toBeUndefined()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('set() PUTs the base64-encoded bytes with the auth header and URL-encoded vaultId', async () => {
    const fetch = mockFetch(undefined, 204)
    vi.stubGlobal('fetch', fetch)
    const storage = new RemoteEdgesyncBlobStorage({ vaultId: 'a vault', getToken: () => 'tok' })

    await storage.set('open/content/abcd', new Uint8Array([1, 2, 3, 4, 5]))

    expect(fetch).toHaveBeenCalledWith(
      '/api/v1/vaults/a%20vault/edgesync-blobs/open/content/abcd',
      expect.objectContaining({
        method: 'PUT',
        headers: expect.objectContaining({ Authorization: 'Bearer tok', 'Content-Type': 'application/json' }),
        body: JSON.stringify({ bytesBase64: 'AQIDBAU=' }),
      }),
    )
  })

  it('set() never calls fetch for secret/* keys', async () => {
    const fetch = mockFetch(undefined, 204)
    vi.stubGlobal('fetch', fetch)
    const storage = new RemoteEdgesyncBlobStorage({ vaultId: 'v1', getToken: () => 'tok' })

    await storage.set('secret/keyring', new Uint8Array([1]))
    expect(fetch).not.toHaveBeenCalled()
  })

  it('set() throws on HTTP error', async () => {
    vi.stubGlobal('fetch', mockFetch(undefined, 500))
    const storage = new RemoteEdgesyncBlobStorage({ vaultId: 'v1', getToken: () => 'tok' })

    await expect(storage.set('open/peers', new Uint8Array([1]))).rejects.toThrow('500')
  })

  it('delete() is a no-op (never calls fetch)', async () => {
    const fetch = mockFetch(undefined, 204)
    vi.stubGlobal('fetch', fetch)
    const storage = new RemoteEdgesyncBlobStorage({ vaultId: 'v1', getToken: () => 'tok' })

    await expect(storage.delete('open/peers')).resolves.toBeUndefined()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('prepends baseUrl when provided', async () => {
    const fetch = mockFetch({ bytesBase64: 'AQ==' })
    vi.stubGlobal('fetch', fetch)
    const storage = new RemoteEdgesyncBlobStorage({ vaultId: 'v1', baseUrl: 'https://api.example.com', getToken: () => 'tok' })

    await storage.get('open/founder')

    expect(fetch).toHaveBeenCalledWith(
      'https://api.example.com/api/v1/vaults/v1/edgesync-blobs/open/founder',
      expect.anything(),
    )
  })

  it('omits Authorization header when getToken() returns null', async () => {
    const fetch = mockFetch({ bytesBase64: 'AQ==' })
    vi.stubGlobal('fetch', fetch)
    const storage = new RemoteEdgesyncBlobStorage({ vaultId: 'v1', getToken: () => null })

    await storage.get('open/founder')

    expect(fetch).toHaveBeenCalledWith('/api/v1/vaults/v1/edgesync-blobs/open/founder', { headers: {} })
  })
})
