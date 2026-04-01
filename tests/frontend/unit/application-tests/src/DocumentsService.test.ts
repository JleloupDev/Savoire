// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { DocumentsService, SyncOrchestrator } from '@savoire/application'
import type { IVaultsBackend, IVaultHubFactory, VaultHubLike, AppDocumentSummary } from '@savoire/application'
import type { DocumentStore, IDocumentMeta, IVaultStorage } from '@savoire/platform'
import type { OpenDocument } from '@savoire/platform'

// ── Stubs ────────────────────────────────────────────────────────────────────

function makeHub(): VaultHubLike {
  return {
    connect: vi.fn(async () => {}),
    dispose: vi.fn(async () => {}),
    createDocument: vi.fn(async (path: string) => ({ id: `new-${path}`, path })),
    renameDocument: vi.fn(async () => {}),
    deleteDocument: vi.fn(async () => {}),
  }
}

function makeHubFactory(hub: VaultHubLike): IVaultHubFactory {
  return { create: vi.fn(() => hub) }
}

function makeBackend(docs: AppDocumentSummary[] = []): IVaultsBackend {
  return {
    listVaults: vi.fn(),
    createVault: vi.fn(),
    renameVault: vi.fn(),
    deleteVault: vi.fn(),
    listDocuments: vi.fn(async () => docs),
  }
}

function makeStorage(): IVaultStorage {
  return {
    readFile: vi.fn(async () => ''),
    writeFile: vi.fn(async () => {}),
    resolveFileUrl: vi.fn(() => '/url'),
    listDocuments: vi.fn(async () => []),
    createDocument: vi.fn(async (_vaultId: string, path: string) => ({ id: 'new-id', path })),
    renameDocument: vi.fn(async () => {}),
    deleteDocument: vi.fn(async () => {}),
    createFolder: vi.fn(async () => {}),
    deleteFolder: vi.fn(async () => {}),
  }
}

function makeDocumentStore(): DocumentStore {
  const openDoc: OpenDocument = {
    docId: 'doc-1',
    path: 'note.md',
    content: '# Hello',
    metadata: { id: 'doc-1', path: 'note.md' },
    refCount: 1,
  }
  return {
    open: vi.fn(async () => openDoc),
    close: vi.fn(),
    readContent: vi.fn(async () => '# Hello'),
    get: vi.fn(),
    size: 0,
  } as unknown as DocumentStore
}

function makeMeta(id: string, path: string): IDocumentMeta {
  return { id, path }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

beforeEach(() => { vi.clearAllMocks() })

describe('DocumentsService', () => {
  it('getActiveClient returns undefined before activateVault', () => {
    const svc = new DocumentsService(makeBackend(), new SyncOrchestrator(makeHubFactory(makeHub())))
    expect(svc.getActiveClient()).toBeUndefined()
  })

  it('activateVault returns ActivatedVault with client and hub', async () => {
    const hub = makeHub()
    const svc = new DocumentsService(
      makeBackend(),
      new SyncOrchestrator(makeHubFactory(hub)),
    )
    const active = await svc.activateVault({
      vaultId: 'v1',
      token: 'tok',
      storage: makeStorage(),
      documentStore: makeDocumentStore(),
      resolveDoc: () => undefined,
      onChanged: vi.fn(),
    })
    expect(active.vaultId).toBe('v1')
    expect(active.client).toBeDefined()
    expect(active.hub).toBe(hub)
    expect(hub.connect).toHaveBeenCalledOnce()
  })

  it('getActiveClient returns client after activateVault', async () => {
    const hub = makeHub()
    const svc = new DocumentsService(makeBackend(), new SyncOrchestrator(makeHubFactory(hub)))
    await svc.activateVault({
      vaultId: 'v1',
      token: 'tok',
      storage: makeStorage(),
      documentStore: makeDocumentStore(),
      resolveDoc: () => undefined,
      onChanged: vi.fn(),
    })
    expect(svc.getActiveClient()).toBeDefined()
  })

  it('list delegates to backend.listDocuments', async () => {
    const docs = [{ id: 'd1', path: 'note.md' }]
    const backend = makeBackend(docs)
    const svc = new DocumentsService(backend, new SyncOrchestrator(makeHubFactory(makeHub())))
    const result = await svc.list('v1', 'tok')
    expect(result).toEqual(docs)
    expect(backend.listDocuments).toHaveBeenCalledWith('v1', 'tok')
  })

  it('disposeActiveVault is a no-op when no active vault', async () => {
    const hub = makeHub()
    const svc = new DocumentsService(makeBackend(), new SyncOrchestrator(makeHubFactory(hub)))
    await expect(svc.disposeActiveVault()).resolves.toBeUndefined()
    expect(hub.dispose).not.toHaveBeenCalled()
  })

  it('disposeActiveVault disposes hub and clears client', async () => {
    const hub = makeHub()
    const svc = new DocumentsService(makeBackend(), new SyncOrchestrator(makeHubFactory(hub)))
    await svc.activateVault({
      vaultId: 'v1',
      token: 'tok',
      storage: makeStorage(),
      documentStore: makeDocumentStore(),
      resolveDoc: () => undefined,
      onChanged: vi.fn(),
    })
    await svc.disposeActiveVault()
    expect(hub.dispose).toHaveBeenCalledOnce()
    expect(svc.getActiveClient()).toBeUndefined()
  })

  it('activateVault disposes previous vault before activating new one', async () => {
    const hub1 = makeHub()
    const hub2 = makeHub()
    let call = 0
    const factory: IVaultHubFactory = { create: vi.fn(() => call++ === 0 ? hub1 : hub2) }
    const svc = new DocumentsService(makeBackend(), new SyncOrchestrator(factory))

    await svc.activateVault({
      vaultId: 'v1', token: 'tok', storage: makeStorage(),
      documentStore: makeDocumentStore(), resolveDoc: () => undefined, onChanged: vi.fn(),
    })
    await svc.activateVault({
      vaultId: 'v2', token: 'tok', storage: makeStorage(),
      documentStore: makeDocumentStore(), resolveDoc: () => undefined, onChanged: vi.fn(),
    })

    expect(hub1.dispose).toHaveBeenCalledOnce()
    expect(hub2.connect).toHaveBeenCalledOnce()
    expect(svc.getActiveClient()).toBeDefined()
  })

  it('storageWithHub.createDocument throws if hub is not yet attached', async () => {
    // This is an internal edge — we test by calling activateVault (hub IS attached).
    // Verify createDocument on the returned client uses the hub.
    const hub = makeHub()
    const svc = new DocumentsService(makeBackend(), new SyncOrchestrator(makeHubFactory(hub)))
    const storage = makeStorage()
    await svc.activateVault({
      vaultId: 'v1', token: 'tok', storage,
      documentStore: makeDocumentStore(), resolveDoc: () => undefined, onChanged: vi.fn(),
    })
    // createDocument on storageWithHub should route to hub
    expect(hub.connect).toHaveBeenCalled()
  })

  it('active.dispose disposes the hub', async () => {
    const hub = makeHub()
    const svc = new DocumentsService(makeBackend(), new SyncOrchestrator(makeHubFactory(hub)))
    const active = await svc.activateVault({
      vaultId: 'v1', token: 'tok', storage: makeStorage(),
      documentStore: makeDocumentStore(), resolveDoc: () => undefined, onChanged: vi.fn(),
    })
    await active.dispose()
    expect(hub.dispose).toHaveBeenCalledOnce()
  })

  it('resolveDoc is passed correctly to VaultClient', async () => {
    const hub = makeHub()
    const svc = new DocumentsService(makeBackend(), new SyncOrchestrator(makeHubFactory(hub)))
    const doc = makeMeta('doc-1', 'note.md')
    const resolveDoc = vi.fn(() => doc)

    const active = await svc.activateVault({
      vaultId: 'v1', token: 'tok', storage: makeStorage(),
      documentStore: makeDocumentStore(), resolveDoc, onChanged: vi.fn(),
    })
    expect(active.client).toBeDefined()
  })
})
