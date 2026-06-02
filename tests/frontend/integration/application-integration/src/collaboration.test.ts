// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { IDocumentMeta } from '@savoire/platform'
import { makeAppRoot } from './helpers/makeAppRoot'
import { makeVaultHub } from './helpers/makeVaultHub'

const ADMIN_EMAIL = 'admin@local.dev'
const ADMIN_PASSWORD = 'Admin1234!'
const GUEST_EMAIL = `collab-guest-${Date.now()}@local.dev`
const GUEST_PASSWORD = 'Guest12345!'

describe('Collaboration — two clients via Application layer', () => {
  let adminToken = ''
  let adminUserId = ''
  let guestToken = ''
  let guestUserId = ''
  let vaultId = ''
  let sharedDoc: IDocumentMeta

  const adminRoot = makeAppRoot(() => adminToken)
  const guestRoot = makeAppRoot(() => guestToken)

  beforeAll(async () => {
    const adminRes = await adminRoot.api.auth.login(ADMIN_EMAIL, ADMIN_PASSWORD)
    adminToken = adminRes.accessToken
    adminUserId = adminRes.user.id

    await adminRoot.api.admin.createUser(adminToken, GUEST_EMAIL, GUEST_PASSWORD, 'Guest User', false)
    const users = await adminRoot.api.admin.listUsers(adminToken)
    guestUserId = users.find(u => u.email === GUEST_EMAIL)!.id

    const guestRes = await guestRoot.api.auth.login(GUEST_EMAIL, GUEST_PASSWORD)
    guestToken = guestRes.accessToken

    const vault = await adminRoot.api.vaults.create(adminUserId, 'Collab Test Vault', adminToken)
    vaultId = vault.id

    const hubTemp = await makeVaultHub(vaultId, () => adminToken)
    sharedDoc = await hubTemp.createDocument('shared-collab.md')
    await hubTemp.dispose()
  })

  afterAll(async () => {
    if (vaultId) await adminRoot.api.vaults.delete(vaultId, adminToken).catch(() => {})
    if (guestUserId) await adminRoot.api.admin.disableUser(adminToken, guestUserId).catch(() => {})
  })

  // ── Vault-level access ──────────────────────────────────────────────────────

  it('guest workspace does not contain the vault before sharing', async () => {
    const ws = await guestRoot.api.vaults.list(guestUserId, guestToken)
    expect(ws.vaults.some(v => v.id === vaultId)).toBe(false)
  })

  it('admin grants read access to guest', async () => {
    const perm = await adminRoot.api.sharing.grantPermission('vault', vaultId, guestUserId, 'read', adminToken)
    expect(perm.subjectId).toBe(guestUserId)
    expect(perm.permission).toBe('read')
  })

  it('guest workspace now contains the shared vault', async () => {
    const ws = await guestRoot.api.vaults.list(guestUserId, guestToken)
    const shared = ws.vaults.find(v => v.id === vaultId)
    expect(shared).toBeTruthy()
    expect(shared!.role).toBe('viewer')
  })

  it('guest can read the shared vault CRDT directory', async () => {
    const guestHub = await makeVaultHub(vaultId, () => guestToken, guestUserId)
    expect(Array.isArray(guestHub.documents())).toBe(true)
    await guestHub.dispose()
  })

  it('guest cannot delete the shared vault (owner only)', async () => {
    await expect(guestRoot.api.vaults.delete(vaultId, guestToken)).rejects.toThrow()
  })

  // ── Permission upgrade ──────────────────────────────────────────────────────

  it('admin upgrades guest to write access', async () => {
    const perm = await adminRoot.api.sharing.grantPermission('vault', vaultId, guestUserId, 'write', adminToken)
    expect(perm.permission).toBe('write')
  })

  it('guest vault role reflects write upgrade', async () => {
    const ws = await guestRoot.api.vaults.list(guestUserId, guestToken)
    const shared = ws.vaults.find(v => v.id === vaultId)
    expect(shared!.role).toBe('editor')
  })

  // ── Revocation ──────────────────────────────────────────────────────────────

  it('admin revokes guest access', async () => {
    await expect(
      adminRoot.api.sharing.revokePermission('vault', vaultId, guestUserId, adminToken)
    ).resolves.not.toThrow()
  })

  it('guest workspace no longer contains the vault after revocation', async () => {
    const ws = await guestRoot.api.vaults.list(guestUserId, guestToken)
    expect(ws.vaults.some(v => v.id === vaultId)).toBe(false)
  })

  // Note: document-content access after revocation is enforced at the document
  // level (JoinDocument → RequireDocumentReadAsync), covered in resilience.test.ts.
  // Vault-directory ACL (JoinVault) is deferred to the ACL pillar (P4).

  // ── Share link ──────────────────────────────────────────────────────────────

  it('admin creates a share link for the vault', async () => {
    const link = await adminRoot.api.sharing.createShareLink('vault', vaultId, 'read', adminToken)
    expect(link.token).toBeTruthy()
    expect(link.isValid).toBe(true)
  })

  it('anyone can redeem a share link and get vault info', async () => {
    const sharing = await adminRoot.api.sharing.getSharing('vault', vaultId, adminToken)
    const link = sharing.links.find(l => l.isValid)!
    const access = await guestRoot.api.sharing.accessShareLink(link.token)
    expect(access.resourceId).toBe(vaultId)
    expect(access.permission).toBe('read')
  })

  // ── sharedWithMe ─────────────────────────────────────────────────────────────

  it('sharedWithMe contains document after doc-level permission is granted to guest', async () => {
    await adminRoot.api.sharing.grantPermission('document', sharedDoc.id, guestUserId, 'read', adminToken)

    const ws = await guestRoot.api.vaults.list(guestUserId, guestToken)
    const note = ws.sharedWithMe.find(n => n.documentId === sharedDoc.id)
    expect(note).toBeTruthy()
    expect(note!.vaultId).toBe(vaultId)
    expect(note!.permission).toBe('read')
  })
})
