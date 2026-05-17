// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import { describe, it, expect, beforeAll } from 'vitest'
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
