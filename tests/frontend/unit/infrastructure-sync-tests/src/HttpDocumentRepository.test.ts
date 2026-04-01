// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import { describe, it, expect, vi } from 'vitest'
import { HttpDocumentRepository } from '@savoire/infrastructure-sync'

function makeJsonResponse(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body, text: async () => '' } as unknown as Response
}

function makeTextResponse(body: string): Response {
  return { ok: true, status: 200, json: async () => ({}), text: async () => body } as unknown as Response
}

function makeErrorResponse(status: number): Response {
  return { ok: false, status, json: async () => ({}), text: async () => '' } as unknown as Response
}

describe('HttpDocumentRepository', () => {
  it('listByVault returns document metas', async () => {
    const fetchFn = vi.fn(async (url: string) => {
      if ((url as string).endsWith('/documents')) {
        return makeJsonResponse([{ id: 'd1', path: 'note.md', updatedAt: '2026-01-01T00:00:00.000Z' }])
      }
      return makeTextResponse('')
    })
    const repo = new HttpDocumentRepository({ fetchFn })
    const docs = await repo.listByVault('v1')
    expect(docs).toHaveLength(1)
    expect(docs[0].documentId).toBe('d1')
    expect(docs[0].path).toBe('note.md')
  })

  it('listByVault returns empty array when no documents', async () => {
    const fetchFn = vi.fn(async () => makeJsonResponse([]))
    const repo = new HttpDocumentRepository({ fetchFn })
    expect(await repo.listByVault('v1')).toEqual([])
  })

  it('getById returns document with content', async () => {
    const fetchFn = vi.fn(async (url: string) => {
      if ((url as string).includes('/content')) return makeTextResponse('# Note')
      return makeJsonResponse([{ id: 'd1', path: 'note.md', updatedAt: '2026-01-01T00:00:00.000Z' }])
    })
    const repo = new HttpDocumentRepository({ fetchFn })
    const doc = await repo.getById('v1', 'd1')
    expect(doc).toBeDefined()
    expect(doc!.id).toBe('d1')
    expect(doc!.content).toBe('# Note')
  })

  it('getById returns undefined when document not found in list', async () => {
    const fetchFn = vi.fn(async () => makeJsonResponse([{ id: 'other', path: 'other.md' }]))
    const repo = new HttpDocumentRepository({ fetchFn })
    expect(await repo.getById('v1', 'missing')).toBeUndefined()
  })

  it('getByPath returns document for matching path', async () => {
    const fetchFn = vi.fn(async (url: string) => {
      if ((url as string).includes('/content')) return makeTextResponse('# Content')
      return makeJsonResponse([{ id: 'd1', path: 'Inbox/note.md' }])
    })
    const repo = new HttpDocumentRepository({ fetchFn })
    const doc = await repo.getByPath('v1', 'Inbox/note.md')
    expect(doc).toBeDefined()
    expect(doc!.path).toBe('Inbox/note.md')
  })

  it('getByPath returns undefined when path not found', async () => {
    const fetchFn = vi.fn(async () => makeJsonResponse([{ id: 'd1', path: 'other.md' }]))
    const repo = new HttpDocumentRepository({ fetchFn })
    expect(await repo.getByPath('v1', 'missing.md')).toBeUndefined()
  })

  it('save calls PUT for content then PATCH for metadata', async () => {
    const calls: string[] = []
    const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push(`${init?.method}:${url}`)
      return { ok: true, status: 200, json: async () => ({}), text: async () => '' } as unknown as Response
    })
    const repo = new HttpDocumentRepository({ fetchFn })
    const { Document } = await import('@savoire/domain-sync')
    const doc = new Document({ id: 'd1', name: 'note.md', path: 'note.md', content: '# Hello' })
    await repo.save('v1', doc)
    expect(calls).toContain('PUT:/api/v1/vaults/v1/documents/d1/content')
    expect(calls).toContain('PATCH:/api/v1/vaults/v1/documents/d1')
  })

  it('delete calls DELETE on document endpoint', async () => {
    const fetchFn = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => '' } as unknown as Response))
    const repo = new HttpDocumentRepository({ fetchFn })
    await repo.delete('v1', 'd1')
    expect(fetchFn).toHaveBeenCalledWith('/api/v1/vaults/v1/documents/d1', expect.objectContaining({ method: 'DELETE' }))
  })

  it('listByVault URL-encodes vaultId', async () => {
    const fetchFn = vi.fn(async () => makeJsonResponse([]))
    const repo = new HttpDocumentRepository({ fetchFn })
    await repo.listByVault('vault/with/slash')
    expect(fetchFn).toHaveBeenCalledWith(
      `/api/v1/vaults/${encodeURIComponent('vault/with/slash')}/documents`,
      expect.anything(),
    )
  })
})
