// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { makeAppRoot } from './helpers/makeAppRoot'
import { makeVaultHub } from './helpers/makeVaultHub'

const ADMIN_EMAIL = 'admin@local.dev'
const ADMIN_PASSWORD = 'Admin1234!'

describe('Documents — CRDT vault directory', () => {
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

  it('a fresh vault directory is empty', async () => {
    const hub = await makeVaultHub(vaultId, () => token)
    expect(hub.documents()).toHaveLength(0)
    await hub.dispose()
  })

  it('createFile adds a document with a client-generated id', async () => {
    const hub = await makeVaultHub(vaultId, () => token)
    const doc = await hub.createDocument('notes/hello.md')
    expect(doc.id).toBeTruthy()
    expect(doc.path).toBe('notes/hello.md')
    expect(hub.documents().some(d => d.id === doc.id)).toBe(true)
    await hub.dispose()
  })

  it('a created document persists: a new hub joining the vault sees it', async () => {
    const writer = await makeVaultHub(vaultId, () => token)
    const doc = await writer.createDocument('persisted.md')
    await writer.dispose()

    const reader = await makeVaultHub(vaultId, () => token)
    const seen = await reader.waitFor(docs => docs.some(d => d.id === doc.id))
    expect(seen).toBe(true)
    expect(reader.documents().find(d => d.id === doc.id)!.path).toBe('persisted.md')
    await reader.dispose()
  })

  it('renameFile updates the path and persists', async () => {
    const writer = await makeVaultHub(vaultId, () => token)
    const doc = await writer.createDocument('rename-me.md')
    await writer.renameDocument(doc.id, 'renamed.md')
    await writer.dispose()

    const reader = await makeVaultHub(vaultId, () => token)
    const ok = await reader.waitFor(docs => docs.some(d => d.id === doc.id && d.path === 'renamed.md'))
    expect(ok).toBe(true)
    await reader.dispose()
  })

  it('deleteFile removes the document and persists', async () => {
    const writer = await makeVaultHub(vaultId, () => token)
    const doc = await writer.createDocument('delete-me.md')
    await writer.deleteDocument(doc.id)
    await writer.dispose()

    const reader = await makeVaultHub(vaultId, () => token)
    await reader.waitFor(() => true, 200) // let the join apply persisted ops
    expect(reader.documents().some(d => d.id === doc.id)).toBe(false)
    await reader.dispose()
  })

  it('two live hubs converge: create on A propagates to B', async () => {
    const a = await makeVaultHub(vaultId, () => token)
    const b = await makeVaultHub(vaultId, () => token)

    const doc = await a.createDocument('shared-live.md')
    const seen = await b.waitFor(docs => docs.some(d => d.id === doc.id))
    expect(seen).toBe(true)

    await a.dispose()
    await b.dispose()
  })

  it('disposeActiveVault with no active vault does not throw', async () => {
    await expect(root.api.documents.disposeActiveVault()).resolves.not.toThrow()
  })
})
