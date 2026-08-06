// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import { describe, it, expect, vi, afterEach } from 'vitest'
import { ServerVaultKeyProvider } from '@savoire/infrastructure-sync'

function keyHex(byte = 0x5c): string {
  return byte.toString(16).padStart(2, '0').repeat(32)
}

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

describe('ServerVaultKeyProvider', () => {
  it('throws when getToken() returns null', async () => {
    const provider = new ServerVaultKeyProvider({ getToken: () => null })
    await expect(provider.fetchOrCreate()).rejects.toThrow('no auth token')
  })

  it('fetches and decodes the hex key from the server', async () => {
    const fetch = mockFetch({ vaultKey: keyHex(0x7a) })
    vi.stubGlobal('fetch', fetch)

    const provider = new ServerVaultKeyProvider({ getToken: () => 'tok' })
    const key = await provider.fetchOrCreate()

    expect(fetch).toHaveBeenCalledWith(
      '/api/v1/vault-key',
      expect.objectContaining({ headers: { Authorization: 'Bearer tok' } }),
    )
    expect(key).toBeInstanceOf(Uint8Array)
    expect(key.length).toBe(32)
    expect(key.every(b => b === 0x7a)).toBe(true)
  })

  it('does not memoise — a second, non-overlapping call fetches again (server is the source of truth, not this instance)', async () => {
    const fetch = mockFetch({ vaultKey: keyHex() })
    vi.stubGlobal('fetch', fetch)

    const provider = new ServerVaultKeyProvider({ getToken: () => 'tok' })
    await provider.fetchOrCreate()
    await provider.fetchOrCreate()

    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('dedupes callers that overlap in time onto a single in-flight request', async () => {
    const fetch = mockFetch({ vaultKey: keyHex(0x11) })
    vi.stubGlobal('fetch', fetch)

    const provider = new ServerVaultKeyProvider({ getToken: () => 'tok' })
    const [a, b, c] = await Promise.all([provider.fetchOrCreate(), provider.fetchOrCreate(), provider.fetchOrCreate()])

    expect(fetch).toHaveBeenCalledTimes(1)
    expect(a).toEqual(b)
    expect(b).toEqual(c)
  })

  it('throws on HTTP error status', async () => {
    vi.stubGlobal('fetch', mockFetch({ error: 'Unauthorized' }, 401))

    const provider = new ServerVaultKeyProvider({ getToken: () => 'tok' })
    await expect(provider.fetchOrCreate()).rejects.toThrow('401')
  })

  it('prepends baseUrl when provided', async () => {
    const fetch = mockFetch({ vaultKey: keyHex() })
    vi.stubGlobal('fetch', fetch)

    const provider = new ServerVaultKeyProvider({ baseUrl: 'https://api.example.com', getToken: () => 'tok' })
    await provider.fetchOrCreate()

    expect(fetch).toHaveBeenCalledWith(
      'https://api.example.com/api/v1/vault-key',
      expect.anything(),
    )
  })
})
