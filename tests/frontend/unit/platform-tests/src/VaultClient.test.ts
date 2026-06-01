// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { VaultClient, DocumentStore } from '@savoire/platform'
import { InMemoryVaultDirectory } from './InMemoryVaultDirectory'
import type { IDocumentFetcher, IVaultStorage, IDocumentMeta } from '@savoire/platform'

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

const stubStorage: IVaultStorage = {
  readFile: vi.fn(async (_vaultId, path) => `attachment:${path}`),
  writeFile: vi.fn(async () => {}),
  resolveFileUrl: (_vaultId, path) => `/attachments/${path}`,
  listDocuments: vi.fn(async () => []),
  createDocument: vi.fn(async (_vaultId, path) => ({ id: 'new-id', path })),
  renameDocument: vi.fn(async () => {}),
  deleteDocument: vi.fn(async () => {}),
  createFolder: vi.fn(async () => {}),
  deleteFolder: vi.fn(async () => {}),
}

const DOCS: IDocumentMeta[] = [
  makeMeta('id-1', 'note.md'),
  makeMeta('id-2', 'Inbox/todo.md'),
]

const VAULT = 'vault-1'
const TOKEN = 'tok'

function makeClient(fetcher: IDocumentFetcher, docs = DOCS): VaultClient {
  const store = new DocumentStore(fetcher)
  return new VaultClient(VAULT, TOKEN, stubStorage, store, new InMemoryVaultDirectory(), (path) =>
    docs.find(d => d.path === path || d.path === path + '.md'),
  )
}

beforeEach(() => {
  vi.mocked(stubStorage.readFile).mockClear()
  vi.mocked(stubStorage.writeFile).mockClear()
  vi.mocked(stubStorage.createDocument).mockClear()
  vi.mocked(stubStorage.renameDocument).mockClear()
  vi.mocked(stubStorage.createDocument).mockImplementation(async (_vaultId, path) => ({ id: 'new-id', path }))
})

describe('readDocumentByPath() — document path', () => {
  it('routes "note.md" through DocumentStore (not storage)', async () => {
    const fetcher = makeFetcher({ 'id-1': '# Note content' })
    const client = makeClient(fetcher)
    const content = await client.readDocumentByPath('note.md')
    expect(content).toBe('# Note content')
    expect(stubStorage.readFile).not.toHaveBeenCalled()
  })

  it('resolves nested paths "Inbox/todo.md"', async () => {
    const fetcher = makeFetcher({ 'id-2': '- [ ] Task' })
    const client = makeClient(fetcher)
    expect(await client.readDocumentByPath('Inbox/todo.md')).toBe('- [ ] Task')
    expect(stubStorage.readFile).not.toHaveBeenCalled()
  })

  it('appends .md automatically when path has no extension', async () => {
    const fetcher = makeFetcher({ 'id-1': '# Auto-md' })
    const client = makeClient(fetcher)
    expect(await client.readDocumentByPath('note')).toBe('# Auto-md')
  })
})

describe('readDocumentByPath() — attachment fallback', () => {
  it('routes unknown path through IVaultStorage', async () => {
    const client = makeClient(makeFetcher({}))
    const content = await client.readDocumentByPath('image.png')
    expect(content).toBe('attachment:image.png')
    expect(stubStorage.readFile).toHaveBeenCalledWith(VAULT, 'image.png', TOKEN)
  })

  it('falls back for paths not in document list', async () => {
    const client = makeClient(makeFetcher({}), [])
    await client.readDocumentByPath('note.md')
    expect(stubStorage.readFile).toHaveBeenCalled()
  })
})

describe('readDocumentByPath() — no cache', () => {
  it('fetches content on every call (no cache)', async () => {
    const fetcher = makeFetcher({ 'id-1': '# Fresh' })
    const client = makeClient(fetcher)
    await client.readDocumentByPath('note.md')
    await client.readDocumentByPath('note.md')
    expect(fetcher.getDocumentContent).toHaveBeenCalledTimes(2)
  })
})

describe('write()', () => {
  it('delegates to DocumentStore writer using document id', async () => {
    const fetcher = makeFetcher({})
    const client = makeClient(fetcher)
    DOCS.forEach(d => client.addDocument(d))
    await client.write('id-1', 'content')
    expect(fetcher.writeDocumentContent).toHaveBeenCalledWith(VAULT, 'id-1', 'content', TOKEN)
    expect(stubStorage.writeFile).not.toHaveBeenCalled()
  })
})

describe('exists()', () => {
  it('returns true for known document id', async () => {
    const client = makeClient(makeFetcher({ 'id-1': '' }))
    expect(await client.exists('id-1')).toBe(true)
  })

  it('returns false when fetch throws', async () => {
    const client = makeClient(makeFetcher({}))
    expect(await client.exists('missing-id')).toBe(false)
  })
})

describe('createFile()', () => {
  it('does not POST when document already exists in cache', async () => {
    const client = makeClient(makeFetcher({}))
    client.addDocument(makeMeta('id-1', 'note.md'))

    await client.createFile('note.md')

    expect(stubStorage.createDocument).not.toHaveBeenCalled()
  })

  it('deduplicates concurrent create requests for same path via optimistic add', async () => {
    const client = makeClient(makeFetcher({}))

    const p1 = client.createFile('dup.md')
    const p2 = client.createFile('dup.md')

    await Promise.all([p1, p2])

    // Second call returns early because the first optimistic add already added the doc
    expect(stubStorage.createDocument).toHaveBeenCalledTimes(1)
    expect(client.documents).toHaveLength(1)
    expect(client.documents[0].path).toBe('dup.md')
  })

  it('treats 409 conflict as idempotent success', async () => {
    vi.mocked(stubStorage.createDocument).mockRejectedValueOnce(new Error('409'))
    const client = makeClient(makeFetcher({}), [makeMeta('id-existing', 'note.md')])

    await expect(client.createFile('note.md')).resolves.toBeUndefined()
  })
})

describe('renameFile()', () => {
  it('updates CRDT directory (no storage call)', async () => {
    const client = makeClient(makeFetcher({}))
    client.addDocument(makeMeta('id-1', 'original.md'))
    await client.renameFile('id-1', 'renamed.md')
    expect(client.documents.find(d => d.id === 'id-1')?.path).toBe('renamed.md')
    expect(stubStorage.renameDocument).not.toHaveBeenCalled()
  })

  it('appends .md when missing on target path', async () => {
    const client = makeClient(makeFetcher({}))
    client.addDocument(makeMeta('id-1', 'original.md'))
    await client.renameFile('id-1', 'renamed')
    expect(client.documents.find(d => d.id === 'id-1')?.path).toBe('renamed.md')
  })
})

describe('resolveAttachmentUrl()', () => {
  it('delegates to IVaultStorage.resolveFileUrl', () => {
    const client = makeClient(makeFetcher({}))
    expect(client.resolveAttachmentUrl('img.png')).toBe('/attachments/img.png')
  })
})

// ── Group 4 — VaultClient ↔ IVaultDirectory wiring ───────────────────────────

describe('VaultClient — directory wiring', () => {
  it('documents getter reflects directory state', () => {
    const directory = new InMemoryVaultDirectory()
    const store = new DocumentStore(makeFetcher({}))
    const client = new VaultClient(VAULT, TOKEN, stubStorage, store, directory, () => undefined)

    directory.add(makeMeta('id-1', 'note.md'))
    expect(client.documents).toEqual([makeMeta('id-1', 'note.md')])
  })

  it('addDocument() triggers onChange on client', () => {
    const client = makeClient(makeFetcher({}))
    let fired = false
    const unsub = client.onChange(() => { fired = true })
    client.addDocument(makeMeta('new', 'new.md'))
    expect(fired).toBe(true)
    unsub()
  })

  it('removeDocument() triggers onChange on client', () => {
    const client = makeClient(makeFetcher({}))
    client.addDocument(makeMeta('x', 'x.md'))
    let fired = false
    const unsub = client.onChange(() => { fired = true })
    client.removeDocument('x')
    expect(fired).toBe(true)
    unsub()
  })

  it('renameDocumentInCache() triggers onChange', () => {
    const client = makeClient(makeFetcher({}))
    client.addDocument(makeMeta('x', 'old.md'))
    let fired = false
    const unsub = client.onChange(() => { fired = true })
    client.renameDocumentInCache('x', 'new.md')
    expect(fired).toBe(true)
    unsub()
  })

})
