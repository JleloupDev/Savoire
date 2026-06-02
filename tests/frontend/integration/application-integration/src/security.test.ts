// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { IDocumentMeta } from '@savoire/platform'
import { makeAppRoot } from './helpers/makeAppRoot'
import { makeVaultHub } from './helpers/makeVaultHub'

const ADMIN_EMAIL = 'admin@local.dev'
const ADMIN_PASSWORD = 'Admin1234!'
const REGULAR_EMAIL = `security-user-${Date.now()}@local.dev`
const REGULAR_PASSWORD = 'SecUser12345!'

describe('Security — unauthorized access', () => {
  let adminToken = ''
  let adminUserId = ''
  let regularToken = ''
  let regularUserId = ''
  let vaultId = ''
  let doc: IDocumentMeta

  const adminRoot   = makeAppRoot(() => adminToken)
  const regularRoot = makeAppRoot(() => regularToken)

  beforeAll(async () => {
    const adminRes = await adminRoot.api.auth.login(ADMIN_EMAIL, ADMIN_PASSWORD)
    adminToken  = adminRes.accessToken
    adminUserId = adminRes.user.id

    await adminRoot.api.admin.createUser(adminToken, REGULAR_EMAIL, REGULAR_PASSWORD, 'Security User', false)
    const users = await adminRoot.api.admin.listUsers(adminToken)
    regularUserId = users.find(u => u.email === REGULAR_EMAIL)!.id

    const regularRes = await regularRoot.api.auth.login(REGULAR_EMAIL, REGULAR_PASSWORD)
    regularToken = regularRes.accessToken

    const vault = await adminRoot.api.vaults.create(adminUserId, 'Security Test Vault', adminToken)
    vaultId = vault.id

    const hub = await makeVaultHub(vaultId, () => adminToken)
    doc = await hub.createDocument('secret.md')
    await hub.dispose()
  })

  afterAll(async () => {
    if (vaultId)      await adminRoot.api.vaults.delete(vaultId, adminToken).catch(() => {})
    if (regularUserId) await adminRoot.api.admin.disableUser(adminToken, regularUserId).catch(() => {})
  })

  // ── Admin-only endpoints ─────────────────────────────────────────────────────

  it('non-admin cannot list users', async () => {
    await expect(regularRoot.api.admin.listUsers(regularToken)).rejects.toThrow()
  })

  it('non-admin cannot create users', async () => {
    await expect(
      regularRoot.api.admin.createUser(regularToken, 'hacker@local.dev', 'Hacker12345!', 'Hacker', false)
    ).rejects.toThrow()
  })

  it('non-admin cannot reset another user password', async () => {
    await expect(
      regularRoot.api.admin.resetPassword(regularToken, adminUserId, 'NewPass99!!')
    ).rejects.toThrow()
  })

  // ── Vault access without permission ─────────────────────────────────────────

  it('user without vault permission cannot read a document (CRDT join denied)', async () => {
    await expect(
      regularRoot.api.documentSession.read(vaultId, doc.id, regularToken)
    ).rejects.toThrow()
  })

  it('user without vault permission cannot delete vault', async () => {
    await expect(regularRoot.api.vaults.delete(vaultId, regularToken)).rejects.toThrow()
  })

  it('user without vault permission cannot rename vault', async () => {
    await expect(regularRoot.api.vaults.rename(vaultId, 'Stolen', regularToken)).rejects.toThrow()
  })

  // ── Share link invalidation ──────────────────────────────────────────────────

  it('revoked share link token is rejected by server', async () => {
    const link = await adminRoot.api.sharing.createShareLink('vault', vaultId, 'read', adminToken)
    await adminRoot.api.sharing.revokeShareLink(link.id, adminToken)
    await expect(adminRoot.api.sharing.accessShareLink(link.token)).rejects.toThrow()
  })
})
