// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// Les comptes se creent chez le fournisseur d'identite (ADR-028) : Savoire
// les voit a leur premiere connexion, et peut les bloquer.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { makeAppRoot } from './helpers/makeAppRoot'
import { ADMIN_EMAIL, ADMIN_LOGIN, ADMIN_PASSWORD, devLogin, ensureDevUser } from './helpers/idp'

const TEST_USER_EMAIL = `test-admin-${Date.now()}@local.dev`
const TEST_USER_PASSWORD = 'Test12345!'

describe('Admin — via Application layer', () => {
  let adminToken = ''
  let createdUserId = ''
  const root = makeAppRoot(() => adminToken)

  beforeAll(async () => {
    const res = await devLogin(ADMIN_LOGIN, ADMIN_PASSWORD)
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
    expect(users.some(u => u.email === ADMIN_EMAIL && u.isAdmin)).toBe(true)
  })

  it('a user created at the identity provider appears after the first login', async () => {
    await ensureDevUser(TEST_USER_EMAIL, TEST_USER_PASSWORD, 'Test User')
    const res = await devLogin(TEST_USER_EMAIL, TEST_USER_PASSWORD)
    expect(res.accessToken).toBeTruthy()
    expect(res.user.email).toBe(TEST_USER_EMAIL)
    const users = await root.api.admin.listUsers(adminToken)
    const created = users.find(u => u.email === TEST_USER_EMAIL)
    expect(created).toBeTruthy()
    createdUserId = created!.id
  })

  it('disableUser locks the account, and its token is refused at once', async () => {
    const res = await devLogin(TEST_USER_EMAIL, TEST_USER_PASSWORD)
    await root.api.admin.disableUser(adminToken, createdUserId)
    const users = await root.api.admin.listUsers(adminToken)
    expect(users.find(u => u.id === createdUserId)?.isLockedOut).toBe(true)
    const me = await fetch(`${process.env.SERVER_URL ?? 'http://localhost:5000'}/api/v1/auth/me`, {
      headers: { authorization: `Bearer ${res.accessToken}` },
    })
    expect(me.status).toBe(401)
    createdUserId = ''
  })
})
