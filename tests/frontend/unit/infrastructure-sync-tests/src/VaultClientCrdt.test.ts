// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import { describe, it, expect, vi } from 'vitest'
import { VaultClient, DocumentStore } from '@savoire/platform'
import type { IDocumentMeta, IVaultStorage, IVaultDirectory } from '@savoire/platform'
import { YMapVaultDirectory } from '@savoire/infrastructure-sync'

const VAULT = 'vault-1'
const TOKEN = 'tok'

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

function makeMeta(id: string, path: string): IDocumentMeta {
  return { id, path }
}

function makeClient(dir: YMapVaultDirectory): VaultClient {
  return new VaultClient(VAULT, TOKEN, stubStorage, new DocumentStore({ getDocumentContent: vi.fn(), writeDocumentContent: vi.fn() }), dir, () => undefined)
}

describe('VaultClient — CRDT sync (YMapVaultDirectory)', () => {
  it('two clients sharing updates via onLocalVaultUpdate / applyVaultUpdate converge', () => {
    const dirA = new YMapVaultDirectory()
    const dirB = new YMapVaultDirectory()
    const clientA = makeClient(dirA)
    const clientB = makeClient(dirB)

    const unsub = clientA.onLocalVaultUpdate(update => clientB.applyVaultUpdate(update))

    clientA.addDocument(makeMeta('shared', 'shared.md'))
    expect(clientB.documents).toEqual([makeMeta('shared', 'shared.md')])

    unsub()
    dirA.dispose(); dirB.dispose()
  })

  it('encodeVaultState() + applyVaultUpdate() enable initial state transfer', () => {
    const dirA = new YMapVaultDirectory()
    const dirB = new YMapVaultDirectory()
    const clientA = makeClient(dirA)
    const clientB = makeClient(dirB)

    clientA.addDocument(makeMeta('a1', 'a1.md'))
    clientA.addDocument(makeMeta('a2', 'a2.md'))

    clientB.applyVaultUpdate(clientA.encodeVaultState())

    expect(clientB.documents.map(d => d.id).sort()).toEqual(['a1', 'a2'])

    dirA.dispose(); dirB.dispose()
  })

  it('removeDocument() on A propagates to B via CRDT wire', () => {
    const dirA = new YMapVaultDirectory()
    const dirB = new YMapVaultDirectory()
    const clientA = makeClient(dirA)
    const clientB = makeClient(dirB)

    const unsub = clientA.onLocalVaultUpdate(update => clientB.applyVaultUpdate(update))
    clientA.addDocument(makeMeta('x', 'x.md'))
    expect(clientB.documents).toHaveLength(1)

    clientA.removeDocument('x')
    expect(clientB.documents).toHaveLength(0)

    unsub()
    dirA.dispose(); dirB.dispose()
  })

  it('renameDocumentInCache() on A propagates to B via CRDT wire', () => {
    const dirA = new YMapVaultDirectory()
    const dirB = new YMapVaultDirectory()
    const clientA = makeClient(dirA)
    const clientB = makeClient(dirB)

    const unsub = clientA.onLocalVaultUpdate(update => clientB.applyVaultUpdate(update))
    clientA.addDocument(makeMeta('doc', 'old.md'))
    clientA.renameDocumentInCache('doc', 'new.md')

    expect(clientB.documents[0]?.path).toBe('new.md')

    unsub()
    dirA.dispose(); dirB.dispose()
  })
})

// ── VaultHubClient wiring — onLocalVaultUpdate → pushVaultUpdate ──────────────

describe('VaultHubClient wiring — local mutations reach pushVaultUpdate', () => {
  it('addDocument() triggers pushVaultUpdate with a non-empty op', () => {
    const dir = new YMapVaultDirectory()
    const client = makeClient(dir)

    const pushed: Uint8Array[] = []
    const unsub = client.onLocalVaultUpdate(op => pushed.push(op))

    client.addDocument(makeMeta('doc', 'doc.md'))

    expect(pushed).toHaveLength(1)
    expect(pushed[0].length).toBeGreaterThan(0)

    unsub()
    dir.dispose()
  })

  it('removeDocument() triggers pushVaultUpdate', () => {
    const dir = new YMapVaultDirectory()
    const client = makeClient(dir)
    client.addDocument(makeMeta('x', 'x.md'))

    const pushed: Uint8Array[] = []
    const unsub = client.onLocalVaultUpdate(op => pushed.push(op))
    client.removeDocument('x')

    expect(pushed).toHaveLength(1)

    unsub()
    dir.dispose()
  })

  it('renameDocumentInCache() triggers pushVaultUpdate', () => {
    const dir = new YMapVaultDirectory()
    const client = makeClient(dir)
    client.addDocument(makeMeta('doc', 'old.md'))

    const pushed: Uint8Array[] = []
    const unsub = client.onLocalVaultUpdate(op => pushed.push(op))
    client.renameDocumentInCache('doc', 'new.md')

    expect(pushed).toHaveLength(1)

    unsub()
    dir.dispose()
  })

  it('applyVaultUpdate() does NOT trigger pushVaultUpdate (no loopback)', () => {
    const dirA = new YMapVaultDirectory()
    const dirB = new YMapVaultDirectory()
    const clientA = makeClient(dirA)
    const clientB = makeClient(dirB)

    // Wire A→B
    clientA.onLocalVaultUpdate(op => clientB.applyVaultUpdate(op))

    // Track B's own local updates — there should be none when applying remote op
    const bLocalUpdates: Uint8Array[] = []
    clientB.onLocalVaultUpdate(op => bLocalUpdates.push(op))

    clientA.addDocument(makeMeta('shared', 'shared.md'))

    // B received the op but must not re-emit it as a local update
    expect(bLocalUpdates).toHaveLength(0)
    expect(clientB.documents).toHaveLength(1)

    dirA.dispose(); dirB.dispose()
  })

  it('dispose() stops pushVaultUpdate from being called', () => {
    const dir = new YMapVaultDirectory()
    const client = makeClient(dir)

    const pushed: Uint8Array[] = []
    // Simulate what VaultHubClient does: wire onLocalVaultUpdate in constructor
    const mockPushVaultUpdate = vi.fn(async (op: Uint8Array) => { pushed.push(op) })
    const unsub = client.onLocalVaultUpdate(op => void mockPushVaultUpdate(op))

    client.addDocument(makeMeta('a', 'a.md'))
    expect(pushed).toHaveLength(1)

    // Simulate dispose: unsubscribe
    unsub()
    client.addDocument(makeMeta('b', 'b.md'))
    expect(pushed).toHaveLength(1) // no new push after unsubscribe

    dir.dispose()
  })
})
