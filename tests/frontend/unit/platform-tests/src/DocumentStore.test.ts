// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import { describe, it, expect, vi } from 'vitest'
import { DocumentStore } from '@savoire/platform'
import type { IDocumentFetcher, IDocumentMeta } from '@savoire/platform'

function makeMeta(id: string, path: string): IDocumentMeta {
  return { id, path }
}

function makeFetcher(contents: Record<string, string>): IDocumentFetcher {
  return {
    getDocumentContent: vi.fn(async (_vaultId, docId) => {
      if (docId in contents) return contents[docId]
      throw new Error(`Not found: ${docId}`)
    }),
    writeDocumentContent: vi.fn(async () => {}),
  }
}

const VAULT = 'vault-1'

describe('DocumentStore.open()', () => {
  it('fetches content on first open', async () => {
    const fetcher = makeFetcher({ 'doc-1': '# Hello' })
    const store = new DocumentStore(fetcher)
    const doc = await store.open(VAULT, 'doc-1', makeMeta('doc-1', 'note.md'), 'tok')
    expect(doc.content).toBe('# Hello')
    expect(fetcher.getDocumentContent).toHaveBeenCalledOnce()
  })

  it('fetches content on each open (no cache)', async () => {
    const fetcher = makeFetcher({ 'doc-1': '# Hello' })
    const store = new DocumentStore(fetcher)
    await store.open(VAULT, 'doc-1', makeMeta('doc-1', 'note.md'), 'tok')
    await store.open(VAULT, 'doc-1', makeMeta('doc-1', 'note.md'), 'tok')
    expect(fetcher.getDocumentContent).toHaveBeenCalledTimes(2)
  })

  it('returns refCount of 1', async () => {
    const store = new DocumentStore(makeFetcher({ 'doc-1': '' }))
    const doc = await store.open(VAULT, 'doc-1', makeMeta('doc-1', 'note.md'), 'tok')
    expect(doc.refCount).toBe(1)
  })

  it('size is always 0 (no cache)', async () => {
    const store = new DocumentStore(makeFetcher({ 'a': '', 'b': '' }))
    await store.open(VAULT, 'a', makeMeta('a', 'a.md'), 'tok')
    await store.open(VAULT, 'b', makeMeta('b', 'b.md'), 'tok')
    expect(store.size).toBe(0)
  })
})

describe('DocumentStore.close()', () => {
  it('is a no-op', async () => {
    const store = new DocumentStore(makeFetcher({ 'doc-1': '' }))
    await store.open(VAULT, 'doc-1', makeMeta('doc-1', 'note.md'), 'tok')
    expect(() => store.close(VAULT, 'doc-1')).not.toThrow()
    expect(store.get(VAULT, 'doc-1')).toBeUndefined()
    expect(store.size).toBe(0)
  })

  it('is a no-op for unknown doc', () => {
    const store = new DocumentStore(makeFetcher({}))
    expect(() => store.close(VAULT, 'unknown')).not.toThrow()
  })
})

describe('DocumentStore.readContent()', () => {
  it('always fetches from the fetcher (no cache)', async () => {
    const fetcher = makeFetcher({ 'doc-1': '# Fresh' })
    const store = new DocumentStore(fetcher)
    await store.open(VAULT, 'doc-1', makeMeta('doc-1', 'note.md'), 'tok')
    vi.mocked(fetcher.getDocumentContent).mockClear()

    const content = await store.readContent(VAULT, 'doc-1', 'tok')
    expect(content).toBe('# Fresh')
    expect(fetcher.getDocumentContent).toHaveBeenCalledOnce()
  })

  it('fetches when doc was never opened', async () => {
    const fetcher = makeFetcher({ 'doc-2': '# Remote' })
    const store = new DocumentStore(fetcher)
    const content = await store.readContent(VAULT, 'doc-2', 'tok', makeMeta('doc-2', 'doc-2.md'))
    expect(content).toBe('# Remote')
    expect(fetcher.getDocumentContent).toHaveBeenCalledOnce()
  })

  it('size remains 0 after readContent', async () => {
    const store = new DocumentStore(makeFetcher({ 'doc-2': '# Embed' }))
    await store.readContent(VAULT, 'doc-2', 'tok', makeMeta('doc-2', 'doc-2.md'))
    expect(store.size).toBe(0)
  })

  it('fetches on every call — metadata or not', async () => {
    const fetcher = makeFetcher({ 'doc-2': 'content' })
    const store = new DocumentStore(fetcher)
    await store.readContent(VAULT, 'doc-2', 'tok', makeMeta('doc-2', 'doc-2.md'))
    await store.readContent(VAULT, 'doc-2', 'tok')
    expect(fetcher.getDocumentContent).toHaveBeenCalledTimes(2)
  })
})
