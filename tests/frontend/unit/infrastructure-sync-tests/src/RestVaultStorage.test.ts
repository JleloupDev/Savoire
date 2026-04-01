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
  it('calls POST /documents with path and title', async () => {
    const meta = { id: 'new-id', path: 'Inbox/note.md' }
    const fetchFn = makeOk(meta)
    const storage = new RestVaultStorage({ fetchFn: fetchFn as never })
    const result = await storage.createDocument(V, 'Inbox/note.md', TOK)
    expect(result).toEqual(meta)
    expect(fetchFn).toHaveBeenCalledWith(
      `/api/v1/vaults/${V}/documents`,
      expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining('Inbox/note.md'),
      }),
    )
  })

  it('derives title from filename without .md extension', async () => {
    const fetchFn = makeOk({ id: 'x', path: 'my-note.md' })
    const storage = new RestVaultStorage({ fetchFn: fetchFn as never })
    await storage.createDocument(V, 'my-note.md', TOK)
    const body = JSON.parse((fetchFn.mock.calls[0][1] as RequestInit).body as string)
    expect(body.title).toBe('my-note')
  })
})

describe('RestVaultStorage.renameDocument()', () => {
  it('calls PATCH /documents/:id with new path and title', async () => {
    const fetchFn = vi.fn(async () => ({ ok: true, status: 200 }))
    const storage = new RestVaultStorage({ fetchFn: fetchFn as never })
    await storage.renameDocument(V, 'doc-1', 'renamed.md', TOK)
    expect(fetchFn).toHaveBeenCalledWith(
      `/api/v1/vaults/${V}/documents/doc-1`,
      expect.objectContaining({ method: 'PATCH', body: expect.stringContaining('renamed.md') }),
    )
  })

  it('throws on error', async () => {
    const fetchFn = vi.fn(async () => ({ ok: false, status: 404 }))
    const storage = new RestVaultStorage({ fetchFn: fetchFn as never })
    await expect(storage.renameDocument(V, 'x', 'y.md', TOK)).rejects.toThrow('404')
  })
})

describe('RestVaultStorage.deleteDocument()', () => {
  it('calls DELETE /documents/:id', async () => {
    const fetchFn = vi.fn(async () => ({ ok: true, status: 204 }))
    const storage = new RestVaultStorage({ fetchFn: fetchFn as never })
    await storage.deleteDocument(V, 'doc-1', TOK)
    expect(fetchFn).toHaveBeenCalledWith(
      `/api/v1/vaults/${V}/documents/doc-1`,
      expect.objectContaining({ method: 'DELETE' }),
    )
  })

  it('accepts 204 No Content as success', async () => {
    const fetchFn = vi.fn(async () => ({ ok: false, status: 204 }))
    const storage = new RestVaultStorage({ fetchFn: fetchFn as never })
    await expect(storage.deleteDocument(V, 'doc-1', TOK)).resolves.toBeUndefined()
  })
})

describe('RestVaultStorage.createFolder()', () => {
  it('calls POST /folders with path', async () => {
    const fetchFn = vi.fn(async () => ({ ok: true, status: 201 }))
    const storage = new RestVaultStorage({ fetchFn: fetchFn as never })
    await storage.createFolder(V, 'Inbox', TOK)
    expect(fetchFn).toHaveBeenCalledWith(
      `/api/v1/vaults/${V}/folders`,
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ path: 'Inbox' }) }),
    )
  })

  it('throws on error', async () => {
    const fetchFn = vi.fn(async () => ({ ok: false, status: 500 }))
    const storage = new RestVaultStorage({ fetchFn: fetchFn as never })
    await expect(storage.createFolder(V, 'x', TOK)).rejects.toThrow('500')
  })
})

describe('RestVaultStorage.deleteFolder()', () => {
  it('is a no-op when folder is not in the list', async () => {
    const fetchFn = vi.fn(async () => ({ ok: true, status: 200, json: async () => [] }))
    const storage = new RestVaultStorage({ fetchFn: fetchFn as never })
    await storage.deleteFolder(V, 'Missing', TOK)
    expect(fetchFn).toHaveBeenCalledTimes(1) // only the GET
  })

  it('deletes the folder by id when found', async () => {
    const folders = [{ id: 'f1', path: 'Inbox' }]
    let callCount = 0
    const fetchFn = vi.fn(async () => {
      callCount++
      if (callCount === 1) return { ok: true, status: 200, json: async () => folders }
      return { ok: true, status: 204 }
    })
    const storage = new RestVaultStorage({ fetchFn: fetchFn as never })
    await storage.deleteFolder(V, 'Inbox', TOK)
    expect(fetchFn).toHaveBeenCalledTimes(2)
    expect(fetchFn).toHaveBeenNthCalledWith(2,
      expect.stringContaining('f1'),
      expect.objectContaining({ method: 'DELETE' }),
    )
  })

  it('throws when the folder list fetch fails', async () => {
    const fetchFn = vi.fn(async () => ({ ok: false, status: 503, json: async () => null }))
    const storage = new RestVaultStorage({ fetchFn: fetchFn as never })
    await expect(storage.deleteFolder(V, 'x', TOK)).rejects.toThrow('503')
  })
})
