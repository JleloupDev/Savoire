// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { makeAppRoot } from './helpers/makeAppRoot'

const ADMIN_EMAIL = 'admin@local.dev'
const ADMIN_PASSWORD = 'Admin1234!'
const TEST_USER_EMAIL = `test-admin-${Date.now()}@local.dev`
const TEST_USER_PASSWORD = 'Test12345!'

describe('Admin — via Application layer', () => {
  let adminToken = ''
  let createdUserId = ''
  const root = makeAppRoot(() => adminToken)

  beforeAll(async () => {
    const res = await root.api.auth.login(ADMIN_EMAIL, ADMIN_PASSWORD)
    adminToken = res.accessToken
  })

  afterAll(async () => {
    if (createdUserId) {
      await root.api.admin.disableUser(adminToken, createdUserId).catch(() => {})
    }
  })

  it('listUsers returns array of users including admin', async () => {
    const users = await root.api.admin.listUsers(adminToken)
    expect(Array.isArray(users)).toBe(true)
    expect(users.some(u => u.email === ADMIN_EMAIL)).toBe(true)
  })

  it('createUser creates a new user', async () => {
    await expect(
      root.api.admin.createUser(adminToken, TEST_USER_EMAIL, TEST_USER_PASSWORD, 'Test User', false)
    ).resolves.not.toThrow()
    const users = await root.api.admin.listUsers(adminToken)
    const created = users.find(u => u.email === TEST_USER_EMAIL)
    expect(created).toBeTruthy()
    createdUserId = created!.id
  })

  it('created user can login', async () => {
    const userRoot = makeAppRoot(() => '')
    const res = await userRoot.api.auth.login(TEST_USER_EMAIL, TEST_USER_PASSWORD)
    expect(res.accessToken).toBeTruthy()
  })

  it('resetPassword allows login with new password', async () => {
    const newPassword = 'NewPass1234!'
    await root.api.admin.resetPassword(adminToken, createdUserId, newPassword)
    const userRoot = makeAppRoot(() => '')
    const res = await userRoot.api.auth.login(TEST_USER_EMAIL, newPassword)
    expect(res.accessToken).toBeTruthy()
  })

  it('revokeSessions does not throw', async () => {
    await expect(root.api.admin.revokeSessions(adminToken, createdUserId)).resolves.not.toThrow()
  })

  it('disableUser locks the account', async () => {
    await root.api.admin.disableUser(adminToken, createdUserId)
    const users = await root.api.admin.listUsers(adminToken)
    const disabled = users.find(u => u.id === createdUserId)
    expect(disabled?.isLockedOut).toBe(true)
    createdUserId = ''
  })
})
