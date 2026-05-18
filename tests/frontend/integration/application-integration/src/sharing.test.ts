// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { makeAppRoot } from './helpers/makeAppRoot'

const ADMIN_EMAIL = 'admin@local.dev'
const ADMIN_PASSWORD = 'Admin1234!'
const GUEST_EMAIL = `test-sharing-${Date.now()}@local.dev`
const GUEST_PASSWORD = 'Guest12345!'

describe('Sharing — via Application layer', () => {
  let adminToken = ''
  let adminUserId = ''
  let guestUserId = ''
  let vaultId = ''
  let shareLinkId = ''
  const root = makeAppRoot(() => adminToken)

  beforeAll(async () => {
    const adminRes = await root.api.auth.login(ADMIN_EMAIL, ADMIN_PASSWORD)
    adminToken = adminRes.accessToken
    adminUserId = adminRes.user.id

    await root.api.admin.createUser(adminToken, GUEST_EMAIL, GUEST_PASSWORD, 'Guest', false)
    const users = await root.api.admin.listUsers(adminToken)
    guestUserId = users.find(u => u.email === GUEST_EMAIL)!.id

    const vault = await root.api.vaults.create(adminUserId, 'Sharing Test Vault', adminToken)
    vaultId = vault.id
  })

  afterAll(async () => {
    if (vaultId) await root.api.vaults.delete(vaultId, adminToken).catch(() => {})
    if (guestUserId) await root.api.admin.disableUser(adminToken, guestUserId).catch(() => {})
  })

  it('getSharing returns empty permissions and links initially', async () => {
    const sharing = await root.api.sharing.getSharing('vault', vaultId, adminToken)
    expect(sharing.resourceId).toBe(vaultId)
    expect(Array.isArray(sharing.permissions)).toBe(true)
    expect(Array.isArray(sharing.links)).toBe(true)
  })

  it('lookupUserByEmail finds existing user', async () => {
    const user = await root.api.sharing.lookupUserByEmail(GUEST_EMAIL, adminToken)
    expect(user).not.toBeNull()
    expect(user!.id).toBe(guestUserId)
  })

  it('lookupUserByEmail returns null for unknown email', async () => {
    const user = await root.api.sharing.lookupUserByEmail('unknown@nobody.dev', adminToken)
    expect(user).toBeNull()
  })

  it('grantPermission adds guest to vault', async () => {
    const perm = await root.api.sharing.grantPermission('vault', vaultId, guestUserId, 'read', adminToken)
    expect(perm.subjectId).toBe(guestUserId)
    expect(perm.permission).toBe('read')
  })

  it('getSharing shows the new permission', async () => {
    const sharing = await root.api.sharing.getSharing('vault', vaultId, adminToken)
    expect(sharing.permissions.some(p => p.subjectId === guestUserId)).toBe(true)
  })

  it('revokePermission removes guest access', async () => {
    await expect(
      root.api.sharing.revokePermission('vault', vaultId, guestUserId, adminToken)
    ).resolves.not.toThrow()
    const sharing = await root.api.sharing.getSharing('vault', vaultId, adminToken)
    expect(sharing.permissions.some(p => p.subjectId === guestUserId)).toBe(false)
  })

  it('createShareLink returns a valid link', async () => {
    const link = await root.api.sharing.createShareLink('vault', vaultId, 'read', adminToken)
    expect(link.token).toBeTruthy()
    expect(link.isValid).toBe(true)
    shareLinkId = link.id
  })

  it('accessShareLink redeems the token', async () => {
    const sharing = await root.api.sharing.getSharing('vault', vaultId, adminToken)
    const link = sharing.links.find(l => l.id === shareLinkId)!
    const access = await root.api.sharing.accessShareLink(link.token)
    expect(access.resourceId).toBe(vaultId)
    expect(access.permission).toBe('read')
  })

  it('revokeShareLink invalidates the link', async () => {
    await expect(root.api.sharing.revokeShareLink(shareLinkId, adminToken)).resolves.not.toThrow()
    const sharing = await root.api.sharing.getSharing('vault', vaultId, adminToken)
    const link = sharing.links.find(l => l.id === shareLinkId)
    expect(link?.isValid).toBe(false)
  })
})
