// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { DocumentsService, SyncOrchestrator } from '@savoire/application'
import type { IVaultHubFactory, VaultHubLike } from '@savoire/application'
import type { DocumentStore, IDocumentMeta, IVaultStorage } from '@savoire/platform'
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

function makeStorage(): IVaultStorage {
  return {
    readFile: vi.fn(async () => ''),
    writeFile: vi.fn(async () => {}),
    resolveFileUrl: vi.fn(() => '/url'),
    listDocuments: vi.fn(async () => []),
    createFolder: vi.fn(async () => {}),
    deleteFolder: vi.fn(async () => {}),
    listFolders: vi.fn(async () => []),
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
    const svc = new DocumentsService(new SyncOrchestrator(makeHubFactory(makeHub())))
    expect(svc.getActiveClient()).toBeUndefined()
  })

  it('activateVault returns ActivatedVault with client and hub', async () => {
    const hub = makeHub()
    const svc = new DocumentsService(new SyncOrchestrator(makeHubFactory(hub)))
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
    const svc = new DocumentsService(new SyncOrchestrator(makeHubFactory(hub)))
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

  it('disposeActiveVault is a no-op when no active vault', async () => {
    const hub = makeHub()
    const svc = new DocumentsService(new SyncOrchestrator(makeHubFactory(hub)))
    await expect(svc.disposeActiveVault()).resolves.toBeUndefined()
    expect(hub.dispose).not.toHaveBeenCalled()
  })

  it('disposeActiveVault disposes hub and clears client', async () => {
    const hub = makeHub()
    const svc = new DocumentsService(new SyncOrchestrator(makeHubFactory(hub)))
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
    const svc = new DocumentsService(new SyncOrchestrator(factory))

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

  it('activateVault connects the hub', async () => {
    const hub = makeHub()
    const svc = new DocumentsService(new SyncOrchestrator(makeHubFactory(hub)))
    await svc.activateVault({
      vaultId: 'v1', token: 'tok', storage: makeStorage(),
      documentStore: makeDocumentStore(), resolveDoc: () => undefined, onChanged: vi.fn(),
    })
    expect(hub.connect).toHaveBeenCalled()
  })

  it('active.dispose disposes the hub', async () => {
    const hub = makeHub()
    const svc = new DocumentsService(new SyncOrchestrator(makeHubFactory(hub)))
    const active = await svc.activateVault({
      vaultId: 'v1', token: 'tok', storage: makeStorage(),
      documentStore: makeDocumentStore(), resolveDoc: () => undefined, onChanged: vi.fn(),
    })
    await active.dispose()
    expect(hub.dispose).toHaveBeenCalledOnce()
  })

  it('resolveDoc is passed correctly to VaultClient', async () => {
    const hub = makeHub()
    const svc = new DocumentsService(new SyncOrchestrator(makeHubFactory(hub)))
    const doc = makeMeta('doc-1', 'note.md')
    const resolveDoc = vi.fn(() => doc)

    const active = await svc.activateVault({
      vaultId: 'v1', token: 'tok', storage: makeStorage(),
      documentStore: makeDocumentStore(), resolveDoc, onChanged: vi.fn(),
    })
    expect(active.client).toBeDefined()
  })
})
