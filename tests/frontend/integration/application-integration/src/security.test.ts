// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { IDocumentMeta } from '@savoire/platform'
import { makeAppRoot } from './helpers/makeAppRoot'
import { makeVaultHub } from './helpers/makeVaultHub'
import { ADMIN_LOGIN, ADMIN_PASSWORD, devLogin, ensureDevUser } from './helpers/idp'

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
    const adminRes = await devLogin(ADMIN_LOGIN, ADMIN_PASSWORD)
    adminToken  = adminRes.accessToken
    adminUserId = adminRes.user.id

    await ensureDevUser(REGULAR_EMAIL, REGULAR_PASSWORD, 'Security User')
    // Le compte Savoire nait a la premiere connexion (ADR-028).
    regularUserId = (await devLogin(REGULAR_EMAIL, REGULAR_PASSWORD)).user.id

    const regularRes = await devLogin(REGULAR_EMAIL, REGULAR_PASSWORD)
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
