// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import { describe, it, expect, vi } from 'vitest'
import { DocumentSessionService } from '@savoire/application'
import type { DocumentStore, IDocumentMeta } from '@savoire/platform'
import type { OpenDocument } from '@savoire/platform'

function makeMeta(id: string, path: string): IDocumentMeta {
  return { id, path }
}

function makeOpenDoc(content: string): OpenDocument {
  return {
    docId: 'doc-1',
    path: 'note.md',
    content,
    metadata: makeMeta('doc-1', 'note.md'),
    refCount: 1,
  }
}

function makeStore(): DocumentStore {
  return {
    open: vi.fn(async () => makeOpenDoc('# Hello')),
    close: vi.fn(),
    readContent: vi.fn(async () => '# Embed Content'),
    get: vi.fn(),
    size: 0,
  } as unknown as DocumentStore
}

describe('DocumentSessionService', () => {
  it('open delegates to store.open and returns content', async () => {
    const store = makeStore()
    const svc = new DocumentSessionService(store)
    const meta = makeMeta('doc-1', 'note.md')

    const content = await svc.open('v1', 'doc-1', meta, 'tok')

    expect(store.open).toHaveBeenCalledWith('v1', 'doc-1', meta, 'tok')
    expect(content).toBe('# Hello')
  })

  it('open returns the content from the opened document', async () => {
    const store = makeStore()
    vi.mocked(store.open).mockResolvedValue(makeOpenDoc('# Custom Content'))
    const svc = new DocumentSessionService(store)

    const content = await svc.open('v1', 'doc-1', makeMeta('doc-1', 'note.md'), 'tok')
    expect(content).toBe('# Custom Content')
  })

  it('close delegates to store.close', () => {
    const store = makeStore()
    const svc = new DocumentSessionService(store)
    svc.close('v1', 'doc-1')
    expect(store.close).toHaveBeenCalledWith('v1', 'doc-1')
  })

  it('read delegates to store.readContent', async () => {
    const store = makeStore()
    const svc = new DocumentSessionService(store)
    const content = await svc.read('v1', 'doc-1', 'tok')
    expect(store.readContent).toHaveBeenCalledWith('v1', 'doc-1', 'tok')
    expect(content).toBe('# Embed Content')
  })

  it('open propagates store errors', async () => {
    const store = makeStore()
    vi.mocked(store.open).mockRejectedValue(new Error('Not found'))
    const svc = new DocumentSessionService(store)
    await expect(svc.open('v1', 'missing', makeMeta('missing', 'x.md'), 'tok')).rejects.toThrow('Not found')
  })

  it('read propagates store errors', async () => {
    const store = makeStore()
    vi.mocked(store.readContent).mockRejectedValue(new Error('HTTP 404'))
    const svc = new DocumentSessionService(store)
    await expect(svc.read('v1', 'doc-1', 'tok')).rejects.toThrow('HTTP 404')
  })
})
