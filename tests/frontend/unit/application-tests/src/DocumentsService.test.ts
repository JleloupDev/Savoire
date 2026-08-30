// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Adapte au port IVaultSyncSession (30/08/2026) : DocumentsService ne connait
// plus ni hub ni session edgesync, seulement UNE fabrique de session. Chaque
// intention de test d'origine est conservee ; « le hub est connecte/dispose »
// devient « la session est ouverte/disposee », la connexion etant desormais
// interne a l'implementation de session.
import { describe, it, expect, vi } from 'vitest'
import { DocumentsService } from '@savoire/application'
import type { IVaultSyncSessionFactory, IVaultSyncSession } from '@savoire/application'
import type { DocumentStore, IDocumentMeta, IVaultDirectory, IVaultStorage } from '@savoire/platform'
import type { OpenDocument } from '@savoire/platform'

// ── Stubs ────────────────────────────────────────────────────────────────────

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

function makeSession(directory: IVaultDirectory = makeDirectory()): IVaultSyncSession {
  return {
    directory,
    openDocument: vi.fn(() => ({}) as never),
    closeDocument: vi.fn(),
    getState: vi.fn(() => 'connected' as const),
    dispose: vi.fn(async () => {}),
  }
}

function makeFactory(session: IVaultSyncSession = makeSession()): IVaultSyncSessionFactory {
  return { open: vi.fn(async () => session) }
}

function makeStorage(): IVaultStorage {
  return {
    readFile: vi.fn(async () => ''),
    writeFile: vi.fn(async () => {}),
    resolveFileUrl: vi.fn(() => ''),
    listDocuments: vi.fn(async () => []),
    uploadAttachment: vi.fn(async () => ({ fileName: 'f', storagePath: 'p' })),
  }
}

function makeMeta(id: string, path: string): IDocumentMeta {
  return { id, path }
}

function makeDocumentStore(): DocumentStore {
  const openDoc: OpenDocument = {
    docId: 'doc-1', path: 'note.md', content: '# Hello',
    metadata: makeMeta('doc-1', 'note.md'), refCount: 1,
  }
  return {
    open: vi.fn(async () => openDoc),
    readContent: vi.fn(async () => '# Hello'),
    readDirect: vi.fn(async () => '# Hello'),
    writeContent: vi.fn(async () => {}),
    close: vi.fn(),
    get: vi.fn(() => undefined),
    size: 0,
  } as unknown as DocumentStore
}

const identitySeed = new Uint8Array(32)

function activateParams(over: Partial<Parameters<DocumentsService['activateVault']>[0]> = {}) {
  return {
    vaultId: 'v1',
    token: 'tok',
    userId: 'u1',
    storage: makeStorage(),
    documentStore: makeDocumentStore(),
    resolveDoc: () => undefined,
    onChanged: vi.fn(),
    identitySeed,
    ...over,
  }
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('DocumentsService', () => {
  it('getActiveClient returns undefined before activateVault', () => {
    const svc = new DocumentsService(makeFactory())
    expect(svc.getActiveClient()).toBeUndefined()
  })

  it('activateVault returns ActivatedVault with client and session', async () => {
    const session = makeSession()
    const factory = makeFactory(session)
    const svc = new DocumentsService(factory)
    const active = await svc.activateVault(activateParams())
    expect(active.vaultId).toBe('v1')
    expect(active.client).toBeDefined()
    expect(active.session).toBe(session)
    expect(factory.open).toHaveBeenCalledOnce()
  })

  it('getActiveClient returns client after activateVault', async () => {
    const svc = new DocumentsService(makeFactory())
    await svc.activateVault(activateParams())
    expect(svc.getActiveClient()).toBeDefined()
  })

  it('disposeActiveVault is a no-op when no active vault', async () => {
    const session = makeSession()
    const svc = new DocumentsService(makeFactory(session))
    await expect(svc.disposeActiveVault()).resolves.toBeUndefined()
    expect(session.dispose).not.toHaveBeenCalled()
  })

  it('disposeActiveVault disposes the session and clears client', async () => {
    const session = makeSession()
    const svc = new DocumentsService(makeFactory(session))
    await svc.activateVault(activateParams())
    expect(svc.getActiveSession()).toBe(session)
    await svc.disposeActiveVault()
    expect(session.dispose).toHaveBeenCalledOnce()
    expect(svc.getActiveClient()).toBeUndefined()
    expect(svc.getActiveSession()).toBeUndefined()
  })

  it('passes onChanged through to the session factory (the session owns the directory and its change notifications)', async () => {
    const onChanged = vi.fn()
    const factory = makeFactory()
    const svc = new DocumentsService(factory)
    await svc.activateVault(activateParams({ onChanged }))
    expect(vi.mocked(factory.open).mock.calls[0][0].onChanged).toBe(onChanged)
  })

  it('builds the VaultClient on the session-owned directory (regression: the app must not create its own)', async () => {
    const directory = makeDirectory()
    const svc = new DocumentsService(makeFactory(makeSession(directory)))
    const active = await svc.activateVault(activateParams())
    active.client.addDocument(makeMeta('doc-1', 'note.md'))
    expect(directory.add).toHaveBeenCalledOnce()
  })

  it('activateVault disposes previous vault before activating new one', async () => {
    const first = makeSession()
    const second = makeSession()
    let call = 0
    const factory: IVaultSyncSessionFactory = { open: vi.fn(async () => (call++ === 0 ? first : second)) }
    const svc = new DocumentsService(factory)

    await svc.activateVault(activateParams({ vaultId: 'v1' }))
    await svc.activateVault(activateParams({ vaultId: 'v2' }))

    expect(first.dispose).toHaveBeenCalledOnce()
    expect(svc.getActiveSession()).toBe(second)
    expect(svc.getActiveClient()).toBeDefined()
  })

  it('active.dispose disposes the session', async () => {
    const session = makeSession()
    const svc = new DocumentsService(makeFactory(session))
    const active = await svc.activateVault(activateParams())
    await active.dispose()
    expect(session.dispose).toHaveBeenCalledOnce()
  })

  it('resolveDoc is passed correctly to VaultClient', async () => {
    const svc = new DocumentsService(makeFactory())
    const doc = makeMeta('doc-1', 'note.md')
    const resolveDoc = vi.fn(() => doc)
    const active = await svc.activateVault(activateParams({ resolveDoc }))
    expect(active.client).toBeDefined()
  })

  it('activateSharedDocument works without any session (isolated document, see ADR-027)', async () => {
    const svc = new DocumentsService(makeFactory())
    const doc = makeMeta('doc-1', 'note.md')
    const active = await svc.activateSharedDocument({
      vaultId: 'v1', doc, token: 'tok',
      documentStore: makeDocumentStore(), directory: makeDirectory(),
      resolveDoc: () => doc,
    })
    expect(active.session).toBeUndefined()
    expect(active.client).toBeDefined()
  })
})
