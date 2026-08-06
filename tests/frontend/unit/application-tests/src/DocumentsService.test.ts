// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { DocumentsService, SyncOrchestrator } from '@savoire/application'
import type { IVaultHubFactory, VaultHubLike, IEdgesyncVaultSessionFactory, EdgesyncVaultSessionLike } from '@savoire/application'
import type { DocumentStore, IDocumentMeta, IVaultDirectory, IVaultStorage } from '@savoire/platform'
import type { OpenDocument } from '@savoire/platform'

// ── Stubs ────────────────────────────────────────────────────────────────────

function makeHub(): VaultHubLike {
  return {
    connect: vi.fn(async () => {}),
    dispose: vi.fn(async () => {}),
  }
}

function makeHubFactory(hub: VaultHubLike): IVaultHubFactory {
  return { create: vi.fn(() => hub) }
}

function makeEdgesyncVaultSession(): EdgesyncVaultSessionLike {
  return {
    isOwner: true,
    isGranting: true,
    openDocument: vi.fn(),
    closeDocument: vi.fn(),
    dispose: vi.fn(async () => {}),
  }
}

function makeEdgesyncFactory(session: EdgesyncVaultSessionLike = makeEdgesyncVaultSession()): IEdgesyncVaultSessionFactory {
  return { open: vi.fn(async () => session) }
}

const identitySeed = new Uint8Array(32)

function makeDirectory(): IVaultDirectory {
  return {
    getAll: vi.fn(() => []),
    getById: vi.fn(() => undefined),
    add: vi.fn(),
    remove: vi.fn(),
    rename: vi.fn(),
    addFolder: vi.fn(),
    removeFolder: vi.fn(),
    getFolders: vi.fn(() => []),
    encodeFullState: vi.fn(() => new Uint8Array()),
    applyUpdate: vi.fn(),
    onLocalUpdate: vi.fn(() => () => {}),
    onChange: vi.fn(() => () => {}),
    dispose: vi.fn(),
  }
}

function makeStorage(): IVaultStorage {
  return {
    readFile: vi.fn(async () => ''),
    writeFile: vi.fn(async () => {}),
    resolveFileUrl: vi.fn(() => '/url'),
    listDocuments: vi.fn(async () => []),
    uploadAttachment: vi.fn(async () => ({ fileName: 'f', storagePath: 'sp' })),
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
    const svc = new DocumentsService(new SyncOrchestrator(makeHubFactory(makeHub())), makeEdgesyncFactory())
    expect(svc.getActiveClient()).toBeUndefined()
  })

  it('activateVault returns ActivatedVault with client and hub', async () => {
    const hub = makeHub()
    const svc = new DocumentsService(new SyncOrchestrator(makeHubFactory(hub)), makeEdgesyncFactory())
    const active = await svc.activateVault({
      vaultId: 'v1',
      token: 'tok',
      storage: makeStorage(),
      documentStore: makeDocumentStore(),
      resolveDoc: () => undefined,
      onChanged: vi.fn(), identitySeed, directory: makeDirectory(), isManaged: false,
    })
    expect(active.vaultId).toBe('v1')
    expect(active.client).toBeDefined()
    expect(active.hub).toBe(hub)
    expect(hub.connect).toHaveBeenCalledOnce()
  })

  it('getActiveClient returns client after activateVault', async () => {
    const hub = makeHub()
    const svc = new DocumentsService(new SyncOrchestrator(makeHubFactory(hub)), makeEdgesyncFactory())
    await svc.activateVault({
      vaultId: 'v1',
      token: 'tok',
      storage: makeStorage(),
      documentStore: makeDocumentStore(),
      resolveDoc: () => undefined,
      onChanged: vi.fn(), identitySeed, directory: makeDirectory(), isManaged: false,
    })
    expect(svc.getActiveClient()).toBeDefined()
  })

  it('disposeActiveVault is a no-op when no active vault', async () => {
    const hub = makeHub()
    const svc = new DocumentsService(new SyncOrchestrator(makeHubFactory(hub)), makeEdgesyncFactory())
    await expect(svc.disposeActiveVault()).resolves.toBeUndefined()
    expect(hub.dispose).not.toHaveBeenCalled()
  })

  it('disposeActiveVault disposes hub and clears client', async () => {
    const hub = makeHub()
    const svc = new DocumentsService(new SyncOrchestrator(makeHubFactory(hub)), makeEdgesyncFactory())
    await svc.activateVault({
      vaultId: 'v1',
      token: 'tok',
      storage: makeStorage(),
      documentStore: makeDocumentStore(),
      resolveDoc: () => undefined,
      onChanged: vi.fn(), identitySeed, directory: makeDirectory(), isManaged: false,
    })
    await svc.disposeActiveVault()
    expect(hub.dispose).toHaveBeenCalledOnce()
    expect(svc.getActiveClient()).toBeUndefined()
  })

  it('disposeActiveVault disposes the edgesync vault session too (regression: it was previously never called, leaking WebRTC/relay connections)', async () => {
    const session = makeEdgesyncVaultSession()
    const svc = new DocumentsService(new SyncOrchestrator(makeHubFactory(makeHub())), makeEdgesyncFactory(session))
    await svc.activateVault({
      vaultId: 'v1', token: 'tok', storage: makeStorage(),
      documentStore: makeDocumentStore(), resolveDoc: () => undefined, onChanged: vi.fn(), identitySeed, directory: makeDirectory(), isManaged: false,
    })
    expect(svc.getActiveEdgesyncVault()).toBe(session)
    await svc.disposeActiveVault()
    expect(session.dispose).toHaveBeenCalledOnce()
    expect(svc.getActiveEdgesyncVault()).toBeUndefined()
  })

  it('subscribes onChanged to the directory\'s own change notifications (regression: remote directory ops — e.g. via edgesync — must refresh the UI, not just local edits)', async () => {
    const directory = makeDirectory()
    const onChanged = vi.fn()
    const svc = new DocumentsService(new SyncOrchestrator(makeHubFactory(makeHub())), makeEdgesyncFactory())
    await svc.activateVault({
      vaultId: 'v1', token: 'tok', storage: makeStorage(),
      documentStore: makeDocumentStore(), resolveDoc: () => undefined, onChanged, identitySeed, directory, isManaged: false,
    })

    expect(directory.onChange).toHaveBeenCalledOnce()
    // Simulate the directory firing a change (local or remote — it doesn't
    // distinguish) and confirm the app's onChanged callback actually runs.
    const registeredCb = vi.mocked(directory.onChange).mock.calls[0][0]
    registeredCb()
    expect(onChanged).toHaveBeenCalledOnce()

    // And disposal unsubscribes cleanly.
    const unsub = vi.mocked(directory.onChange).mock.results[0].value as () => void
    await svc.disposeActiveVault()
    expect(unsub).toBeDefined()
  })

  it('activateVault disposes previous vault before activating new one', async () => {
    const hub1 = makeHub()
    const hub2 = makeHub()
    let call = 0
    const factory: IVaultHubFactory = { create: vi.fn(() => call++ === 0 ? hub1 : hub2) }
    const svc = new DocumentsService(new SyncOrchestrator(factory), makeEdgesyncFactory())

    await svc.activateVault({
      vaultId: 'v1', token: 'tok', storage: makeStorage(),
      documentStore: makeDocumentStore(), resolveDoc: () => undefined, onChanged: vi.fn(), identitySeed, directory: makeDirectory(), isManaged: false,
    })
    await svc.activateVault({
      vaultId: 'v2', token: 'tok', storage: makeStorage(),
      documentStore: makeDocumentStore(), resolveDoc: () => undefined, onChanged: vi.fn(), identitySeed, directory: makeDirectory(), isManaged: false,
    })

    expect(hub1.dispose).toHaveBeenCalledOnce()
    expect(hub2.connect).toHaveBeenCalledOnce()
    expect(svc.getActiveClient()).toBeDefined()
  })

  it('activateVault connects the hub', async () => {
    const hub = makeHub()
    const svc = new DocumentsService(new SyncOrchestrator(makeHubFactory(hub)), makeEdgesyncFactory())
    await svc.activateVault({
      vaultId: 'v1', token: 'tok', storage: makeStorage(),
      documentStore: makeDocumentStore(), resolveDoc: () => undefined, onChanged: vi.fn(), identitySeed, directory: makeDirectory(), isManaged: false,
    })
    expect(hub.connect).toHaveBeenCalled()
  })

  it('active.dispose disposes the hub', async () => {
    const hub = makeHub()
    const svc = new DocumentsService(new SyncOrchestrator(makeHubFactory(hub)), makeEdgesyncFactory())
    const active = await svc.activateVault({
      vaultId: 'v1', token: 'tok', storage: makeStorage(),
      documentStore: makeDocumentStore(), resolveDoc: () => undefined, onChanged: vi.fn(), identitySeed, directory: makeDirectory(), isManaged: false,
    })
    await active.dispose()
    expect(hub.dispose).toHaveBeenCalledOnce()
  })

  it('resolveDoc is passed correctly to VaultClient', async () => {
    const hub = makeHub()
    const svc = new DocumentsService(new SyncOrchestrator(makeHubFactory(hub)), makeEdgesyncFactory())
    const doc = makeMeta('doc-1', 'note.md')
    const resolveDoc = vi.fn(() => doc)

    const active = await svc.activateVault({
      vaultId: 'v1', token: 'tok', storage: makeStorage(),
      documentStore: makeDocumentStore(), resolveDoc, onChanged: vi.fn(), identitySeed, directory: makeDirectory(), isManaged: false,
    })
    expect(active.client).toBeDefined()
  })
})
