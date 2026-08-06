// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import { describe, it, expect, vi, afterEach } from 'vitest'
import { ManagedVaultKeyringSource } from '@savoire/infrastructure-sync'
import { Keyring, randomBytes } from 'edgesync-protocol'

function mockFetch(handler: (url: string, init?: RequestInit) => { status: number; body?: unknown }) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    const { status, body } = handler(url, init)
    return { ok: status >= 200 && status < 300, status, json: async () => body }
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

function sampleKeyring(): Keyring {
  const kr = Keyring.genesis(() => randomBytes(32))
  kr.mintDocKey(0, randomBytes(32), () => randomBytes(32))
  return kr
}

describe('ManagedVaultKeyringSource', () => {
  it('save() puis fetch() fait un roundtrip fidele du Keyring (en clair, aucun K_User implique)', async () => {
    let stored: string | undefined
    vi.stubGlobal('fetch', mockFetch((_url, init) => {
      if (init?.method === 'PUT') {
        stored = (JSON.parse(init.body as string) as { bytesBase64: string }).bytesBase64
        return { status: 204 }
      }
      return stored ? { status: 200, body: { bytesBase64: stored } } : { status: 404 }
    }))

    const source = new ManagedVaultKeyringSource({ getToken: () => 'tok' })
    const original = sampleKeyring()

    await source.save('vault-1', original)
    const restored = await source.fetch('vault-1')

    expect(restored).toBeDefined()
    expect(restored!.currentEpoch()).toBe(original.currentEpoch())
    expect(restored!.vaultKey(0)).toEqual(original.vaultKey(0))
  })

  it('fetch() renvoie undefined sur 404 (rien encore stocke) sans lever d\'erreur', async () => {
    vi.stubGlobal('fetch', mockFetch(() => ({ status: 404 })))
    const source = new ManagedVaultKeyringSource({ getToken: () => 'tok' })

    await expect(source.fetch('vault-1')).resolves.toBeUndefined()
  })

  it('fetch() leve une erreur explicite sur un statut HTTP inattendu', async () => {
    vi.stubGlobal('fetch', mockFetch(() => ({ status: 500 })))
    const source = new ManagedVaultKeyringSource({ getToken: () => 'tok' })

    await expect(source.fetch('vault-1')).rejects.toThrow('500')
  })

  it('save() leve une erreur explicite sur un statut HTTP en echec', async () => {
    vi.stubGlobal('fetch', mockFetch(() => ({ status: 500 })))
    const source = new ManagedVaultKeyringSource({ getToken: () => 'tok' })

    await expect(source.save('vault-1', sampleKeyring())).rejects.toThrow('500')
  })

  it('utilise l\'URL /managed-keyring avec vaultId encode, et prepend baseUrl si fourni', async () => {
    const fetchMock = mockFetch(() => ({ status: 404 }))
    vi.stubGlobal('fetch', fetchMock)
    const source = new ManagedVaultKeyringSource({ baseUrl: 'https://api.example.com', getToken: () => 'tok' })

    await source.fetch('a vault')

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.example.com/api/v1/vaults/a%20vault/managed-keyring',
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer tok' }) }),
    )
  })

  it('omet le header Authorization quand getToken() renvoie null', async () => {
    const fetchMock = mockFetch(() => ({ status: 404 }))
    vi.stubGlobal('fetch', fetchMock)
    const source = new ManagedVaultKeyringSource({ getToken: () => null })

    await source.fetch('vault-1')

    expect(fetchMock).toHaveBeenCalledWith('/api/v1/vaults/vault-1/managed-keyring', { headers: {} })
  })
})
