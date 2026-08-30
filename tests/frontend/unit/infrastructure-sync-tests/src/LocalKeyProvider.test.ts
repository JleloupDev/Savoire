// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { LocalKeyProvider } from '@savoire/infrastructure-sync'

vi.mock('@noble/ed25519', () => ({
  getPublicKeyAsync: vi.fn(async (priv: Uint8Array) => priv.map(b => b ^ 0xff)),
  signAsync: vi.fn(async () => new Uint8Array(64).fill(0xcc)),
}))

const STORAGE_KEY = 'savoire:identity:privateKey'

function makeStorage(): Storage {
  const store: Record<string, string> = {}
  return {
    getItem: (k: string) => store[k] ?? null,
    setItem: (k: string, v: string) => { store[k] = v },
    removeItem: (k: string) => { delete store[k] },
    clear: () => { for (const k of Object.keys(store)) delete store[k] },
    get length() { return Object.keys(store).length },
    key: (i: number) => Object.keys(store)[i] ?? null,
  } as unknown as Storage
}

let storage: Storage

beforeEach(() => {
  storage = makeStorage()
  vi.stubGlobal('localStorage', storage)
  vi.stubGlobal('crypto', {
    getRandomValues: (arr: Uint8Array) => { arr.fill(0x42); return arr },
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('LocalKeyProvider', () => {
  it('getPublicKey() throws before init()', () => {
    const provider = new LocalKeyProvider()
    expect(() => provider.getPublicKey()).toThrow('not initialised')
  })

  it('sign() throws before init()', async () => {
    const provider = new LocalKeyProvider()
    await expect(provider.sign(new Uint8Array([1]))).rejects.toThrow('not initialised')
  })

  it('init() generates a 64-char hex key and stores it in localStorage', async () => {
    const provider = new LocalKeyProvider()
    await provider.init()

    const stored = storage.getItem(STORAGE_KEY)
    expect(stored).not.toBeNull()
    expect(stored!.length).toBe(64) // 32 bytes × 2 hex chars
    expect(/^[0-9a-f]{64}$/.test(stored!)).toBe(true)
  })

  it('init() loads an existing key from localStorage without overwriting it', async () => {
    const hexKey = '42'.repeat(32)
    storage.setItem(STORAGE_KEY, hexKey)

    const provider = new LocalKeyProvider()
    await provider.init()

    expect(storage.getItem(STORAGE_KEY)).toBe(hexKey)
  })

  it('two providers sharing the same localStorage produce the same public key', async () => {
    const p1 = new LocalKeyProvider()
    await p1.init()

    const p2 = new LocalKeyProvider()
    await p2.init()

    expect(p1.getPublicKey()).toEqual(p2.getPublicKey())
  })

  it('getPublicKey() returns a 32-byte Uint8Array after init()', async () => {
    const provider = new LocalKeyProvider()
    await provider.init()

    const pub = provider.getPublicKey()
    expect(pub).toBeInstanceOf(Uint8Array)
    expect(pub.length).toBe(32)
  })

  it('sign() returns a 64-byte signature after init()', async () => {
    const provider = new LocalKeyProvider()
    await provider.init()

    const sig = await provider.sign(new Uint8Array([1, 2, 3]))
    expect(sig).toBeInstanceOf(Uint8Array)
    expect(sig.length).toBe(64)
  })

  it('getPublicKey() is consistent across multiple calls', async () => {
    const provider = new LocalKeyProvider()
    await provider.init()

    expect(provider.getPublicKey()).toEqual(provider.getPublicKey())
  })

  it('two providers with different stored keys produce different public keys', async () => {
    storage.setItem(STORAGE_KEY, '11'.repeat(32))
    const p1 = new LocalKeyProvider()
    await p1.init()
    const pub1 = p1.getPublicKey()

    const store2 = makeStorage()
    store2.setItem(STORAGE_KEY, '22'.repeat(32))
    vi.stubGlobal('localStorage', store2)
    const p2 = new LocalKeyProvider()
    await p2.init()
    const pub2 = p2.getPublicKey()

    expect(pub1).not.toEqual(pub2)
  })

  it('exportSignSeed() throws before init()', () => {
    const provider = new LocalKeyProvider()
    expect(() => provider.exportSignSeed()).toThrow('not initialised')
  })

  it('exportSignSeed() returns the same 32-byte seed used to derive the public key', async () => {
    const hexKey = '42'.repeat(32)
    storage.setItem(STORAGE_KEY, hexKey)

    const provider = new LocalKeyProvider()
    await provider.init()

    const seed = provider.exportSignSeed()
    expect(seed).toBeInstanceOf(Uint8Array)
    expect(seed.length).toBe(32)
    expect(seed.every(b => b === 0x42)).toBe(true)
  })
})
