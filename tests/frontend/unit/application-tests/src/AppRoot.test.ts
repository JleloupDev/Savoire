// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
/**
 * Integration test: AppRoot wires all services together correctly.
 * Tests the composition root (ApplicationAPI) via AppRoot.
 */
import { describe, it, expect, vi } from 'vitest'
import { AppRoot } from '@savoire/application'
import type { IVaultsBackend, IVaultHubFactory, VaultHubLike } from '@savoire/application'
import type { DocumentStore } from '@savoire/platform'
import type { OpenDocument } from '@savoire/platform'

function makeBackend(): IVaultsBackend {
  return {
    listVaults: vi.fn(async () => []),
    createVault: vi.fn(async () => ({
      id: 'v1', name: 'Main', role: 'owner',
      documentCount: 0, folderCount: 0, lastModifiedAt: null, sizeBytes: 0,
    })),
    renameVault: vi.fn(async () => ({
      id: 'v1', name: 'Renamed', role: 'owner',
      documentCount: 0, folderCount: 0, lastModifiedAt: null, sizeBytes: 0,
    })),
    deleteVault: vi.fn(async () => {}),
    listDocuments: vi.fn(async () => []),
  }
}

function makeHub(): VaultHubLike {
  return {
    connect: vi.fn(async () => {}),
    dispose: vi.fn(async () => {}),
    createDocument: vi.fn(async (path: string) => ({ id: `id-${path}`, path })),
    renameDocument: vi.fn(async () => {}),
    deleteDocument: vi.fn(async () => {}),
  }
}

function makeHubFactory(): IVaultHubFactory {
  const hub = makeHub()
  return { create: vi.fn(() => hub) }
}

function makeDocumentStore(): DocumentStore {
  const openDoc: OpenDocument = {
    docId: 'doc-1', path: 'note.md', content: '# Hello',
    metadata: { id: 'doc-1', path: 'note.md' }, refCount: 1,
  }
  return {
    open: vi.fn(async () => openDoc),
    close: vi.fn(),
    readContent: vi.fn(async () => '# Hello'),
    get: vi.fn(),
    size: 0,
  } as unknown as DocumentStore
}

describe('AppRoot (integration)', () => {
  it('exposes api with all four service namespaces', () => {
    const root = new AppRoot({
      backend: makeBackend(),
      hubFactory: makeHubFactory(),
      documentStore: makeDocumentStore(),
    })
    expect(root.api.vaults).toBeDefined()
    expect(root.api.documents).toBeDefined()
    expect(root.api.documentSession).toBeDefined()
    expect(root.api.workspace).toBeDefined()
  })

  it('api.vaults.list delegates to backend', async () => {
    const backend = makeBackend()
    const root = new AppRoot({ backend, hubFactory: makeHubFactory(), documentStore: makeDocumentStore() })
    await root.api.vaults.list('user1', 'tok')
    expect(backend.listVaults).toHaveBeenCalledWith('user1', 'tok')
  })

  it('api.vaults.create delegates to backend', async () => {
    const backend = makeBackend()
    const root = new AppRoot({ backend, hubFactory: makeHubFactory(), documentStore: makeDocumentStore() })
    const result = await root.api.vaults.create('user1', 'New Vault', 'tok')
    expect(result.name).toBe('Main') // returns backend stub value
    expect(backend.createVault).toHaveBeenCalledWith('user1', 'New Vault', 'tok')
  })

  it('api.vaults.rename delegates to backend', async () => {
    const backend = makeBackend()
    const root = new AppRoot({ backend, hubFactory: makeHubFactory(), documentStore: makeDocumentStore() })
    const result = await root.api.vaults.rename('v1', 'Renamed', 'tok')
    expect(result.name).toBe('Renamed')
  })

  it('api.vaults.delete delegates to backend', async () => {
    const backend = makeBackend()
    const root = new AppRoot({ backend, hubFactory: makeHubFactory(), documentStore: makeDocumentStore() })
    await root.api.vaults.delete('v1', 'tok')
    expect(backend.deleteVault).toHaveBeenCalledWith('v1', 'tok')
  })

  it('api.documents.getActiveClient returns undefined before activation', () => {
    const root = new AppRoot({
      backend: makeBackend(), hubFactory: makeHubFactory(), documentStore: makeDocumentStore(),
    })
    expect(root.api.documents.getActiveClient()).toBeUndefined()
  })

  it('api.documentSession.close is callable', () => {
    const store = makeDocumentStore()
    const root = new AppRoot({ backend: makeBackend(), hubFactory: makeHubFactory(), documentStore: store })
    expect(() => root.api.documentSession.close('v1', 'doc-1')).not.toThrow()
    expect(store.close).toHaveBeenCalledWith('v1', 'doc-1')
  })

  it('api.workspace.createVaultProxy creates a working proxy', async () => {
    const root = new AppRoot({
      backend: makeBackend(), hubFactory: makeHubFactory(), documentStore: makeDocumentStore(),
    })
    const proxy = root.api.workspace.createVaultProxy(() => undefined, () => undefined)
    expect(await proxy.list()).toEqual([])
    expect(await proxy.read('doc-1')).toBe('')
    expect(await proxy.exists('doc-1')).toBe(false)
  })
})
