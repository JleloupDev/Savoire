// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ServerKeyProvider } from '@savoire/infrastructure-sync'

vi.mock('@noble/ed25519', () => ({
  getPublicKey: vi.fn(async (priv: Uint8Array) => {
    // deterministic stub: flip every byte so pubkey is visibly distinct from privkey
    return priv.map(b => b ^ 0xff)
  }),
  sign: vi.fn(async () => new Uint8Array(64).fill(0xaa)),
}))

function privHex(byte = 0x42): string {
  return byte.toString(16).padStart(2, '0').repeat(32)
}

function mockFetch(body: unknown, status = 200) {
  return vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  }))
}

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('ServerKeyProvider', () => {
  it('throws when getToken() returns null', async () => {
    const provider = new ServerKeyProvider({ getToken: () => null })
    await expect(provider.sign(new Uint8Array([1]))).rejects.toThrow('no auth token')
  })

  it('fetches identity key on first sign() call', async () => {
    const fetch = mockFetch({ privateKey: privHex() })
    vi.stubGlobal('fetch', fetch)

    const provider = new ServerKeyProvider({ getToken: () => 'tok' })
    await provider.sign(new Uint8Array([1]))

    expect(fetch).toHaveBeenCalledOnce()
    expect(fetch).toHaveBeenCalledWith(
      '/api/v1/identity/key',
      expect.objectContaining({ headers: { Authorization: 'Bearer tok' } }),
    )
  })

  it('does not re-fetch on subsequent sign() calls', async () => {
    vi.stubGlobal('fetch', mockFetch({ privateKey: privHex() }))

    const provider = new ServerKeyProvider({ getToken: () => 'tok' })
    await provider.sign(new Uint8Array([1]))
    await provider.sign(new Uint8Array([2]))

    expect(vi.mocked(globalThis.fetch)).toHaveBeenCalledOnce()
  })

  it('deduplicates concurrent init requests', async () => {
    vi.stubGlobal('fetch', mockFetch({ privateKey: privHex() }))

    const provider = new ServerKeyProvider({ getToken: () => 'tok' })
    await Promise.all([
      provider.sign(new Uint8Array([1])),
      provider.sign(new Uint8Array([2])),
      provider.sign(new Uint8Array([3])),
    ])

    expect(vi.mocked(globalThis.fetch)).toHaveBeenCalledOnce()
  })

  it('resets pending on fetch failure, allowing a retry', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network error') }))

    const provider = new ServerKeyProvider({ getToken: () => 'tok' })
    await expect(provider.sign(new Uint8Array([1]))).rejects.toThrow()

    // retry with a working fetch
    vi.stubGlobal('fetch', mockFetch({ privateKey: privHex() }))
    await expect(provider.sign(new Uint8Array([1]))).resolves.toBeDefined()
  })

  it('throws on HTTP error status', async () => {
    vi.stubGlobal('fetch', mockFetch({ error: 'Unauthorized' }, 401))

    const provider = new ServerKeyProvider({ getToken: () => 'tok' })
    await expect(provider.sign(new Uint8Array([1]))).rejects.toThrow('401')
  })

  it('getPublicKey() throws before sign() is called', () => {
    const provider = new ServerKeyProvider({ getToken: () => 'tok' })
    expect(() => provider.getPublicKey()).toThrow('not initialised')
  })

  it('getPublicKey() returns a 32-byte key after sign() resolves', async () => {
    vi.stubGlobal('fetch', mockFetch({ privateKey: privHex() }))

    const provider = new ServerKeyProvider({ getToken: () => 'tok' })
    await provider.sign(new Uint8Array([1]))

    const pub = provider.getPublicKey()
    expect(pub).toBeInstanceOf(Uint8Array)
    expect(pub.length).toBe(32)
  })

  it('prepends baseUrl when provided', async () => {
    const fetch = mockFetch({ privateKey: privHex() })
    vi.stubGlobal('fetch', fetch)

    const provider = new ServerKeyProvider({ baseUrl: 'https://api.example.com', getToken: () => 'tok' })
    await provider.sign(new Uint8Array([1]))

    expect(fetch).toHaveBeenCalledWith(
      'https://api.example.com/api/v1/identity/key',
      expect.anything(),
    )
  })

  it('sign() returns a 64-byte signature', async () => {
    vi.stubGlobal('fetch', mockFetch({ privateKey: privHex() }))

    const provider = new ServerKeyProvider({ getToken: () => 'tok' })
    const sig = await provider.sign(new Uint8Array([1, 2, 3]))

    expect(sig).toBeInstanceOf(Uint8Array)
    expect(sig.length).toBe(64)
  })
})
