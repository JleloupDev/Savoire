// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import { describe, it, expect, vi } from 'vitest'
import { RestVaultStorage } from '@savoire/infrastructure-sync'

const V = 'vault-1'
const TOK = 'tok'

function makeOk(body: unknown = null) {
  return vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body) ?? ''),
  }))
}

describe('RestVaultStorage.readFile()', () => {
  it('calls GET on the attachment URL and returns text', async () => {
    const fetchFn = vi.fn(async () => ({ ok: true, status: 200, text: async () => 'img data' }))
    const storage = new RestVaultStorage({ fetchFn: fetchFn as never })
    const result = await storage.readFile(V, 'img.png', TOK)
    expect(result).toBe('img data')
    expect(fetchFn).toHaveBeenCalledWith(
      `/api/v1/vaults/${V}/attachments/img.png`,
      expect.objectContaining({ method: 'GET', headers: { Authorization: `Bearer ${TOK}` } }),
    )
  })

  it('throws on non-200 response', async () => {
    const fetchFn = vi.fn(async () => ({ ok: false, status: 403, text: async () => '' }))
    const storage = new RestVaultStorage({ fetchFn: fetchFn as never })
    await expect(storage.readFile(V, 'x.png', TOK)).rejects.toThrow('403')
  })
})

describe('RestVaultStorage.writeFile()', () => {
  it('calls POST to attachments endpoint with form data', async () => {
    const fetchFn = vi.fn(async () => ({ ok: true, status: 200 }))
    const storage = new RestVaultStorage({ fetchFn: fetchFn as never })
    await storage.writeFile(V, 'note.md', '# content', TOK)
    expect(fetchFn).toHaveBeenCalledWith(
      `/api/v1/vaults/${V}/attachments`,
      expect.objectContaining({ method: 'POST' }),
    )
  })

  it('throws on error response', async () => {
    const fetchFn = vi.fn(async () => ({ ok: false, status: 500 }))
    const storage = new RestVaultStorage({ fetchFn: fetchFn as never })
    await expect(storage.writeFile(V, 'x.md', '', TOK)).rejects.toThrow('500')
  })
})

describe('RestVaultStorage.resolveFileUrl()', () => {
  it('returns the attachment URL without a fetch call', () => {
    const storage = new RestVaultStorage()
    expect(storage.resolveFileUrl(V, 'img.png')).toBe(`/api/v1/vaults/${V}/attachments/img.png`)
  })

  it('prepends baseUrl when provided', () => {
    const storage = new RestVaultStorage({ baseUrl: 'http://host' })
    expect(storage.resolveFileUrl(V, 'x.png')).toContain('http://host')
  })
})

describe('RestVaultStorage.listDocuments()', () => {
  it('calls GET and returns JSON array', async () => {
    const docs = [{ id: 'd1', path: 'note.md' }]
    const fetchFn = makeOk(docs)
    const storage = new RestVaultStorage({ fetchFn: fetchFn as never })
    const result = await storage.listDocuments(V, TOK)
    expect(result).toEqual(docs)
  })

  it('throws on error', async () => {
    const fetchFn = vi.fn(async () => ({ ok: false, status: 500, json: async () => null }))
    const storage = new RestVaultStorage({ fetchFn: fetchFn as never })
    await expect(storage.listDocuments(V, TOK)).rejects.toThrow('500')
  })
})

describe('RestVaultStorage.createDocument()', () => {
  it('throws — must go through VaultHub', () => {
    const storage = new RestVaultStorage({})
    expect(() => storage.createDocument(V, 'note.md', TOK)).toThrow('VaultHub')
  })
})

describe('RestVaultStorage.renameDocument()', () => {
  it('throws — must go through VaultHub', () => {
    const storage = new RestVaultStorage({})
    expect(() => storage.renameDocument(V, 'doc-1', 'renamed.md', TOK)).toThrow('VaultHub')
  })
})

describe('RestVaultStorage.deleteDocument()', () => {
  it('throws — must go through VaultHub', () => {
    const storage = new RestVaultStorage({})
    expect(() => storage.deleteDocument(V, 'doc-1', TOK)).toThrow('VaultHub')
  })
})
