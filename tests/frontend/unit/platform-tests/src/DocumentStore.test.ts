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

  it('returns cached doc on second open (no extra fetch)', async () => {
    const fetcher = makeFetcher({ 'doc-1': '# Hello' })
    const store = new DocumentStore(fetcher)
    await store.open(VAULT, 'doc-1', makeMeta('doc-1', 'note.md'), 'tok')
    await store.open(VAULT, 'doc-1', makeMeta('doc-1', 'note.md'), 'tok')
    expect(fetcher.getDocumentContent).toHaveBeenCalledOnce()
  })

  it('increments refCount on each open', async () => {
    const store = new DocumentStore(makeFetcher({ 'doc-1': '' }))
    await store.open(VAULT, 'doc-1', makeMeta('doc-1', 'note.md'), 'tok')
    const doc = await store.open(VAULT, 'doc-1', makeMeta('doc-1', 'note.md'), 'tok')
    expect(doc.refCount).toBe(2)
  })

  it('stores size correctly', async () => {
    const store = new DocumentStore(makeFetcher({ 'a': '', 'b': '' }))
    await store.open(VAULT, 'a', makeMeta('a', 'a.md'), 'tok')
    await store.open(VAULT, 'b', makeMeta('b', 'b.md'), 'tok')
    expect(store.size).toBe(2)
  })
})

describe('DocumentStore.close()', () => {
  it('decrements refCount', async () => {
    const store = new DocumentStore(makeFetcher({ 'doc-1': '' }))
    await store.open(VAULT, 'doc-1', makeMeta('doc-1', 'note.md'), 'tok')
    await store.open(VAULT, 'doc-1', makeMeta('doc-1', 'note.md'), 'tok')
    store.close(VAULT, 'doc-1')
    expect(store.get(VAULT, 'doc-1')?.refCount).toBe(1)
  })

  it('evicts from cache when refCount reaches 0', async () => {
    const store = new DocumentStore(makeFetcher({ 'doc-1': '' }))
    await store.open(VAULT, 'doc-1', makeMeta('doc-1', 'note.md'), 'tok')
    store.close(VAULT, 'doc-1')
    expect(store.get(VAULT, 'doc-1')).toBeUndefined()
    expect(store.size).toBe(0)
  })

  it('is a no-op for unknown doc', () => {
    const store = new DocumentStore(makeFetcher({}))
    expect(() => store.close(VAULT, 'unknown')).not.toThrow()
  })
})

describe('DocumentStore.readContent()', () => {
  it('returns cached content without fetching again', async () => {
    const fetcher = makeFetcher({ 'doc-1': '# Cached' })
    const store = new DocumentStore(fetcher)
    await store.open(VAULT, 'doc-1', makeMeta('doc-1', 'note.md'), 'tok')
    vi.mocked(fetcher.getDocumentContent).mockClear()

    const content = await store.readContent(VAULT, 'doc-1', 'tok')
    expect(content).toBe('# Cached')
    expect(fetcher.getDocumentContent).not.toHaveBeenCalled()
  })

  it('fetches when doc is not cached (embed of un-opened doc)', async () => {
    const fetcher = makeFetcher({ 'doc-2': '# Remote' })
    const store = new DocumentStore(fetcher)
    const content = await store.readContent(VAULT, 'doc-2', 'tok', makeMeta('doc-2', 'doc-2.md'))
    expect(content).toBe('# Remote')
    expect(fetcher.getDocumentContent).toHaveBeenCalledOnce()
  })

  it('caches embed reads when metadata is provided and content is non-empty', async () => {
    const store = new DocumentStore(makeFetcher({ 'doc-2': '# Embed cached' }))
    await store.readContent(VAULT, 'doc-2', 'tok', makeMeta('doc-2', 'doc-2.md'))
    expect(store.size).toBe(1)
    expect(store.get(VAULT, 'doc-2')?.refCount).toBe(0)
  })

  it('does NOT keep passive cache when fetched content is empty', async () => {
    const store = new DocumentStore(makeFetcher({ 'doc-2': '' }))
    await store.readContent(VAULT, 'doc-2', 'tok', makeMeta('doc-2', 'doc-2.md'))
    expect(store.size).toBe(0)
  })

  it('does NOT cache the result when metadata is missing', async () => {
    const store = new DocumentStore(makeFetcher({ 'doc-2': '' }))
    await store.readContent(VAULT, 'doc-2', 'tok')
    expect(store.size).toBe(0)
  })

  it('does NOT modify refCount of an open doc', async () => {
    const store = new DocumentStore(makeFetcher({ 'doc-1': '' }))
    await store.open(VAULT, 'doc-1', makeMeta('doc-1', 'note.md'), 'tok')
    await store.readContent(VAULT, 'doc-1', 'tok')
    expect(store.get(VAULT, 'doc-1')?.refCount).toBe(1)
  })

  it('deduplicates concurrent uncached reads when metadata is provided', async () => {
    let resolveFetch: (value: string) => void = () => { throw new Error('fetch not started') }
    const fetcher: IDocumentFetcher = {
      getDocumentContent: vi.fn(() => new Promise((resolve) => {
        resolveFetch = resolve
      })),
    }
    const store = new DocumentStore(fetcher)
    const meta = makeMeta('doc-3', 'doc-3.md')
    const p1 = store.readContent(VAULT, 'doc-3', 'tok', meta)
    const p2 = store.readContent(VAULT, 'doc-3', 'tok', meta)
    expect(fetcher.getDocumentContent).toHaveBeenCalledTimes(1)

    resolveFetch('# Deferred')
    await expect(Promise.all([p1, p2])).resolves.toEqual(['# Deferred', '# Deferred'])
  })
})
