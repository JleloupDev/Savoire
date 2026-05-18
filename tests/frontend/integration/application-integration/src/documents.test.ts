// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { DocumentStore } from '@savoire/platform'
import { RestVaultStorage, RestDocumentFetcher } from '@savoire/infrastructure-sync'
import { makeAppRoot, makeRealAppRoot, SERVER_URL } from './helpers/makeAppRoot'
import { makeVaultHub } from './helpers/makeVaultHub'

const ADMIN_EMAIL = 'admin@local.dev'
const ADMIN_PASSWORD = 'Admin1234!'

describe('Documents — via Application layer', () => {
  let token = ''
  let userId = ''
  let vaultId = ''
  const root = makeAppRoot(() => token)

  beforeAll(async () => {
    const res = await root.api.auth.login(ADMIN_EMAIL, ADMIN_PASSWORD)
    token = res.accessToken
    userId = res.user.id

    const vault = await root.api.vaults.create(userId, 'Documents Test Vault', token)
    vaultId = vault.id
  })

  afterAll(async () => {
    if (vaultId) await root.api.vaults.delete(vaultId, token).catch(() => {})
  })

  it('list returns empty array for a new vault', async () => {
    const docs = await root.api.documents.list(vaultId, token)
    expect(Array.isArray(docs)).toBe(true)
    expect(docs).toHaveLength(0)
  })

  it('createDocument via hub appears in list', async () => {
    const hub = await makeVaultHub(vaultId, () => token)
    const doc = await hub.hub.createDocument('notes/hello.md')
    await hub.dispose()

    const docs = await root.api.documents.list(vaultId, token)
    expect(docs.some(d => d.id === doc.id)).toBe(true)
    expect(docs.find(d => d.id === doc.id)!.path).toBe('notes/hello.md')
  })

  it('renameDocument via hub updates path in list', async () => {
    const hub = await makeVaultHub(vaultId, () => token)
    const doc = await hub.hub.createDocument('rename-me.md')
    await hub.hub.renameDocument(doc.id, 'renamed.md')
    await hub.dispose()

    const docs = await root.api.documents.list(vaultId, token)
    expect(docs.some(d => d.id === doc.id && d.path === 'renamed.md')).toBe(true)
  })

  it('deleteDocument via hub removes it from list', async () => {
    const hub = await makeVaultHub(vaultId, () => token)
    const doc = await hub.hub.createDocument('delete-me.md')
    await hub.hub.deleteDocument(doc.id)
    await hub.dispose()

    const docs = await root.api.documents.list(vaultId, token)
    expect(docs.some(d => d.id === doc.id)).toBe(false)
  })

  it('activateVault resolves with correct vaultId and hub can create documents', async () => {
    const realRoot = makeRealAppRoot(() => token)
    const storage = new RestVaultStorage({ baseUrl: SERVER_URL })
    const documentStore = new DocumentStore(new RestDocumentFetcher({ baseUrl: SERVER_URL }))

    const activated = await realRoot.api.documents.activateVault({
      vaultId,
      token,
      storage,
      documentStore,
      resolveDoc: () => undefined,
      onChanged: () => {},
    })

    expect(activated.vaultId).toBe(vaultId)

    const doc = await activated.hub.createDocument('activated-test.md')
    expect(doc.id).toBeTruthy()
    expect(doc.path).toBe('activated-test.md')

    const docs = await root.api.documents.list(vaultId, token)
    expect(docs.some(d => d.id === doc.id)).toBe(true)

    await realRoot.api.documents.disposeActiveVault()
  })

  it('disposeActiveVault with no active vault does not throw', async () => {
    await expect(root.api.documents.disposeActiveVault()).resolves.not.toThrow()
  })
})
