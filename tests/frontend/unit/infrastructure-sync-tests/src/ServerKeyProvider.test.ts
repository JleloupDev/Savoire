// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ServerKeyProvider } from '@savoire/infrastructure-sync'

vi.mock('@noble/ed25519', () => ({
  // deterministic stub: flip every byte so pubkey is visibly distinct from privkey
  getPublicKeyAsync: vi.fn(async (priv: Uint8Array) => priv.map(b => b ^ 0xff)),
  signAsync: vi.fn(async () => new Uint8Array(64).fill(0xaa)),
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
    await expect(provider.init()).rejects.toThrow('no auth token')
  })

  it('fetches identity key on init()', async () => {
    const fetch = mockFetch({ privateKey: privHex() })
    vi.stubGlobal('fetch', fetch)

    const provider = new ServerKeyProvider({ getToken: () => 'tok' })
    await provider.init()

    expect(fetch).toHaveBeenCalledOnce()
    expect(fetch).toHaveBeenCalledWith(
      '/api/v1/identity/key',
      expect.objectContaining({ headers: { Authorization: 'Bearer tok' } }),
    )
  })

  it('does not re-fetch on second init() call', async () => {
    vi.stubGlobal('fetch', mockFetch({ privateKey: privHex() }))

    const provider = new ServerKeyProvider({ getToken: () => 'tok' })
    await provider.init()
    await provider.init()

    expect(vi.mocked(globalThis.fetch)).toHaveBeenCalledOnce()
  })

  it('deduplicates concurrent init() calls', async () => {
    vi.stubGlobal('fetch', mockFetch({ privateKey: privHex() }))

    const provider = new ServerKeyProvider({ getToken: () => 'tok' })
    await Promise.all([provider.init(), provider.init(), provider.init()])

    expect(vi.mocked(globalThis.fetch)).toHaveBeenCalledOnce()
  })

  it('resets pending on fetch failure, allowing a retry', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network error') }))

    const provider = new ServerKeyProvider({ getToken: () => 'tok' })
    await expect(provider.init()).rejects.toThrow()

    // retry with a working fetch
    vi.stubGlobal('fetch', mockFetch({ privateKey: privHex() }))
    await expect(provider.init()).resolves.toBeUndefined()
  })

  it('throws on HTTP error status', async () => {
    vi.stubGlobal('fetch', mockFetch({ error: 'Unauthorized' }, 401))

    const provider = new ServerKeyProvider({ getToken: () => 'tok' })
    await expect(provider.init()).rejects.toThrow('401')
  })

  it('getPublicKey() throws before init() is called', () => {
    const provider = new ServerKeyProvider({ getToken: () => 'tok' })
    expect(() => provider.getPublicKey()).toThrow('not initialised')
  })

  it('getPublicKey() returns a 32-byte key after init() resolves', async () => {
    vi.stubGlobal('fetch', mockFetch({ privateKey: privHex() }))

    const provider = new ServerKeyProvider({ getToken: () => 'tok' })
    await provider.init()

    const pub = provider.getPublicKey()
    expect(pub).toBeInstanceOf(Uint8Array)
    expect(pub.length).toBe(32)
  })

  it('prepends baseUrl when provided', async () => {
    const fetch = mockFetch({ privateKey: privHex() })
    vi.stubGlobal('fetch', fetch)

    const provider = new ServerKeyProvider({ baseUrl: 'https://api.example.com', getToken: () => 'tok' })
    await provider.init()

    expect(fetch).toHaveBeenCalledWith(
      'https://api.example.com/api/v1/identity/key',
      expect.anything(),
    )
  })

  it('sign() returns a 64-byte signature after init()', async () => {
    vi.stubGlobal('fetch', mockFetch({ privateKey: privHex() }))

    const provider = new ServerKeyProvider({ getToken: () => 'tok' })
    await provider.init()
    const sig = await provider.sign(new Uint8Array([1, 2, 3]))

    expect(sig).toBeInstanceOf(Uint8Array)
    expect(sig.length).toBe(64)
  })

  it('sign() throws when not initialised', async () => {
    const provider = new ServerKeyProvider({ getToken: () => 'tok' })
    await expect(provider.sign(new Uint8Array([1]))).rejects.toThrow('not initialised')
  })

  it('exportSignSeed() throws before init()', () => {
    const provider = new ServerKeyProvider({ getToken: () => 'tok' })
    expect(() => provider.exportSignSeed()).toThrow('not initialised')
  })

  it('exportSignSeed() returns the fetched private key after init()', async () => {
    vi.stubGlobal('fetch', mockFetch({ privateKey: privHex(0x7a) }))

    const provider = new ServerKeyProvider({ getToken: () => 'tok' })
    await provider.init()

    const seed = provider.exportSignSeed()
    expect(seed).toBeInstanceOf(Uint8Array)
    expect(seed.length).toBe(32)
    expect(seed.every(b => b === 0x7a)).toBe(true)
  })
})
