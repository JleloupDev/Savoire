// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import { describe, it, expect, vi, afterEach } from 'vitest'
import { VaultKeyEscrow, WrongVaultKeyError, bytesToBase64 } from '@savoire/infrastructure-sync'
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

describe('VaultKeyEscrow', () => {
  it('save() puis fetch() avec le meme K_User fait un roundtrip fidele du Keyring', async () => {
    const userKey = randomBytes(32)
    let stored: string | undefined
    vi.stubGlobal('fetch', mockFetch((_url, init) => {
      if (init?.method === 'PUT') {
        stored = (JSON.parse(init.body as string) as { bytesBase64: string }).bytesBase64
        return { status: 204 }
      }
      return stored ? { status: 200, body: { bytesBase64: stored } } : { status: 404 }
    }))

    const escrow = new VaultKeyEscrow({ getToken: () => 'tok', getVaultKey: () => userKey })
    const original = sampleKeyring()

    await escrow.save('vault-1', original)
    const restored = await escrow.fetch('vault-1')

    expect(restored).toBeDefined()
    expect(restored!.currentEpoch()).toBe(original.currentEpoch())
    expect(restored!.vaultKey(0)).toEqual(original.vaultKey(0))
  })

  it('fetch() renvoie undefined sur 404 (rien encore escrowe) sans lever d\'erreur', async () => {
    vi.stubGlobal('fetch', mockFetch(() => ({ status: 404 })))
    const escrow = new VaultKeyEscrow({ getToken: () => 'tok', getVaultKey: () => randomBytes(32) })

    await expect(escrow.fetch('vault-1')).resolves.toBeUndefined()
  })

  it('fetch() leve WrongVaultKeyError quand le K_User ne dechiffre pas le blob stocke (distinct de "rien trouve")', async () => {
    const ownerKey = randomBytes(32)
    let stored: string | undefined
    vi.stubGlobal('fetch', mockFetch((_url, init) => {
      if (init?.method === 'PUT') {
        stored = (JSON.parse(init.body as string) as { bytesBase64: string }).bytesBase64
        return { status: 204 }
      }
      return { status: 200, body: { bytesBase64: stored } }
    }))

    const owner = new VaultKeyEscrow({ getToken: () => 'tok', getVaultKey: () => ownerKey })
    await owner.save('vault-1', sampleKeyring())

    const intruder = new VaultKeyEscrow({ getToken: () => 'tok', getVaultKey: () => randomBytes(32) })
    await expect(intruder.fetch('vault-1')).rejects.toThrow(WrongVaultKeyError)
  })

  it('fetch() renvoie undefined sans K_User quand le serveur n\'a rien (404) — le serveur est quand meme interroge', async () => {
    const fetchMock = mockFetch(() => ({ status: 404 }))
    vi.stubGlobal('fetch', fetchMock)
    const escrow = new VaultKeyEscrow({ getToken: () => 'tok', getVaultKey: () => null })

    expect(await escrow.fetch('vault-1')).toBeUndefined()
    expect(fetchMock).toHaveBeenCalled()
  })

  it('fetch() leve WrongVaultKeyError sans K_User quand le serveur a deja un blob (verrouille, pas "rien a voir")', async () => {
    const fetchMock = mockFetch(() => ({ status: 200, body: { bytesBase64: 'AQ==' } }))
    vi.stubGlobal('fetch', fetchMock)
    const escrow = new VaultKeyEscrow({ getToken: () => 'tok', getVaultKey: () => null })

    await expect(escrow.fetch('vault-1')).rejects.toThrow(WrongVaultKeyError)
  })

  it('save() ne fait rien (pas d\'appel HTTP) quand aucun K_User n\'est disponible', async () => {
    const fetchMock = mockFetch(() => ({ status: 204 }))
    vi.stubGlobal('fetch', fetchMock)
    const escrow = new VaultKeyEscrow({ getToken: () => 'tok', getVaultKey: () => null })

    await escrow.save('vault-1', sampleKeyring())
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('fetch() leve une erreur explicite sur un statut HTTP inattendu (ni 200 ni 404)', async () => {
    vi.stubGlobal('fetch', mockFetch(() => ({ status: 500 })))
    const escrow = new VaultKeyEscrow({ getToken: () => 'tok', getVaultKey: () => randomBytes(32) })

    await expect(escrow.fetch('vault-1')).rejects.toThrow('500')
  })

  it('save() leve une erreur explicite sur un statut HTTP en echec', async () => {
    vi.stubGlobal('fetch', mockFetch(() => ({ status: 500 })))
    const escrow = new VaultKeyEscrow({ getToken: () => 'tok', getVaultKey: () => randomBytes(32) })

    await expect(escrow.save('vault-1', sampleKeyring())).rejects.toThrow('500')
  })

  it('utilise l\'URL /key-wrap avec vaultId encode, et prepend baseUrl si fourni', async () => {
    const fetchMock = mockFetch(() => ({ status: 404 }))
    vi.stubGlobal('fetch', fetchMock)
    const escrow = new VaultKeyEscrow({ baseUrl: 'https://api.example.com', getToken: () => 'tok', getVaultKey: () => randomBytes(32) })

    await escrow.fetch('a vault')

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.example.com/api/v1/vaults/a%20vault/key-wrap',
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer tok' }) }),
    )
  })

  it('omet le header Authorization quand getToken() renvoie null', async () => {
    const fetchMock = mockFetch(() => ({ status: 404 }))
    vi.stubGlobal('fetch', fetchMock)
    const escrow = new VaultKeyEscrow({ getToken: () => null, getVaultKey: () => randomBytes(32) })

    await escrow.fetch('vault-1')

    expect(fetchMock).toHaveBeenCalledWith('/api/v1/vaults/vault-1/key-wrap', { headers: {} })
  })

  it('le blob transmis au serveur est opaque : ne contient jamais le K_vault en clair', async () => {
    const userKey = randomBytes(32)
    let sentBase64: string | undefined
    vi.stubGlobal('fetch', mockFetch((_url, init) => {
      sentBase64 = (JSON.parse(init!.body as string) as { bytesBase64: string }).bytesBase64
      return { status: 204 }
    }))

    const escrow = new VaultKeyEscrow({ getToken: () => 'tok', getVaultKey: () => userKey })
    const keyring = sampleKeyring()
    await escrow.save('vault-1', keyring)

    const sentBytes = Uint8Array.from(atob(sentBase64!), (c) => c.charCodeAt(0))
    const vaultKeyBase64 = bytesToBase64(keyring.vaultKey(0)!)
    expect(sentBase64).not.toContain(vaultKeyBase64)
    expect(containsSub(sentBytes, keyring.vaultKey(0)!)).toBe(false)
  })
})

function containsSub(hay: Uint8Array, needle: Uint8Array): boolean {
  outer: for (let i = 0; i + needle.length <= hay.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (hay[i + j] !== needle[j]) continue outer
    }
    return true
  }
  return false
}
