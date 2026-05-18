// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { makeAppRoot } from './helpers/makeAppRoot'

const ADMIN_EMAIL = 'admin@local.dev'
const ADMIN_PASSWORD = 'Admin1234!'

describe('Auth — via Application layer', () => {
  let token = ''
  let refreshToken = ''
  const root = makeAppRoot(() => token)

  it('login with valid credentials returns tokens and user', async () => {
    const res = await root.api.auth.login(ADMIN_EMAIL, ADMIN_PASSWORD)
    expect(res.accessToken).toBeTruthy()
    expect(res.refreshToken).toBeTruthy()
    expect(res.user.email).toBe(ADMIN_EMAIL)
    expect(res.user.isAdmin).toBe(true)
    token = res.accessToken
    refreshToken = res.refreshToken
  })

  it('login with wrong password rejects', async () => {
    await expect(root.api.auth.login(ADMIN_EMAIL, 'wrong')).rejects.toThrow()
  })

  it('refresh returns new tokens', async () => {
    const res = await root.api.auth.refresh(refreshToken)
    expect(res.accessToken).toBeTruthy()
    token = res.accessToken
    refreshToken = res.refreshToken
  })

  it('logout succeeds', async () => {
    await expect(root.api.auth.logout(token, refreshToken)).resolves.not.toThrow()
  })
})

describe('Auth — changePassword', () => {
  const CHANGE_EMAIL = `change-pw-${Date.now()}@local.dev`
  const INITIAL_PASSWORD = 'Initial1234!!'
  const NEW_PASSWORD = 'Changed5678!!'

  let adminToken = ''
  let userId = ''
  let userToken = ''

  const adminRoot = makeAppRoot(() => adminToken)
  const userRoot  = makeAppRoot(() => userToken)

  beforeAll(async () => {
    const res = await adminRoot.api.auth.login(ADMIN_EMAIL, ADMIN_PASSWORD)
    adminToken = res.accessToken
    await adminRoot.api.admin.createUser(adminToken, CHANGE_EMAIL, INITIAL_PASSWORD, 'Change PW User', false)
    const users = await adminRoot.api.admin.listUsers(adminToken)
    userId = users.find(u => u.email === CHANGE_EMAIL)!.id
    const userRes = await userRoot.api.auth.login(CHANGE_EMAIL, INITIAL_PASSWORD)
    userToken = userRes.accessToken
  })

  afterAll(async () => {
    if (userId) await adminRoot.api.admin.disableUser(adminToken, userId).catch(() => {})
  })

  it('changePassword with correct current password succeeds', async () => {
    await expect(
      userRoot.api.auth.changePassword(userToken, INITIAL_PASSWORD, NEW_PASSWORD)
    ).resolves.not.toThrow()
  })

  it('can login with new password after change', async () => {
    const res = await userRoot.api.auth.login(CHANGE_EMAIL, NEW_PASSWORD)
    expect(res.accessToken).toBeTruthy()
    userToken = res.accessToken
  })

  it('cannot login with old password after change', async () => {
    await expect(userRoot.api.auth.login(CHANGE_EMAIL, INITIAL_PASSWORD)).rejects.toThrow()
  })

  it('changePassword with wrong current password rejects', async () => {
    await expect(
      userRoot.api.auth.changePassword(userToken, 'WrongPassword99!!', NEW_PASSWORD)
    ).rejects.toThrow()
  })
})
