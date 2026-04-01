// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import { describe, it, expect, vi } from 'vitest'
import { RestDocumentFetcher } from '@savoire/infrastructure-sync'

describe('RestDocumentFetcher', () => {
  it('returns text on 200', async () => {
    const fetchFn = vi.fn(async () => ({ ok: true, status: 200, text: async () => '# Hello' }))
    const fetcher = new RestDocumentFetcher({ fetchFn: fetchFn as never })
    const result = await fetcher.getDocumentContent('v1', 'doc1', 'tok')
    expect(result).toBe('# Hello')
    expect(fetchFn).toHaveBeenCalledWith(
      '/api/v1/vaults/v1/documents/doc1/content',
      expect.objectContaining({ headers: { Authorization: 'Bearer tok' } }),
    )
  })

  it('returns empty string on 404', async () => {
    const fetchFn = vi.fn(async () => ({ ok: false, status: 404, text: async () => '' }))
    const fetcher = new RestDocumentFetcher({ fetchFn: fetchFn as never })
    const result = await fetcher.getDocumentContent('v1', 'doc1', 'tok')
    expect(result).toBe('')
  })

  it('throws on non-404 error', async () => {
    const fetchFn = vi.fn(async () => ({ ok: false, status: 500, text: async () => '' }))
    const fetcher = new RestDocumentFetcher({ fetchFn: fetchFn as never })
    await expect(fetcher.getDocumentContent('v1', 'doc1', 'tok')).rejects.toThrow('500')
  })

  it('prepends baseUrl when provided', async () => {
    const fetchFn = vi.fn(async () => ({ ok: true, status: 200, text: async () => '' }))
    const fetcher = new RestDocumentFetcher({ baseUrl: 'http://localhost:5000', fetchFn: fetchFn as never })
    await fetcher.getDocumentContent('v1', 'doc1', 'tok')
    expect(fetchFn).toHaveBeenCalledWith(
      expect.stringContaining('http://localhost:5000'),
      expect.anything(),
    )
  })

  it('URL-encodes vaultId and docId', async () => {
    const fetchFn = vi.fn(async () => ({ ok: true, status: 200, text: async () => '' }))
    const fetcher = new RestDocumentFetcher({ fetchFn: fetchFn as never })
    await fetcher.getDocumentContent('vault/1', 'doc/2', 'tok')
    expect(fetchFn).toHaveBeenCalledWith(
      expect.stringContaining('vault%2F1'),
      expect.anything(),
    )
  })
})
