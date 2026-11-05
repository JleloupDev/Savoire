// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// Connexion par le fournisseur d'identite (ADR-028), sans navigateur : le
// vrai parcours de l'appli (code + PKCE), renouvellement, deconnexion.
import { describe, it, expect } from 'vitest'
import { makeAppRoot } from './helpers/makeAppRoot'
import { ADMIN_EMAIL, ADMIN_LOGIN, ADMIN_PASSWORD, devLogin } from './helpers/idp'

describe('Auth — via Application layer', () => {
  const root = makeAppRoot(() => null)
  let token = ''
  let refreshToken = ''

  it('login returns tokens and the Savoire account', async () => {
    const res = await devLogin(ADMIN_LOGIN, ADMIN_PASSWORD)
    expect(res.accessToken).toBeTruthy()
    expect(res.refreshToken).toBeTruthy()
    expect(res.user.email).toBe(ADMIN_EMAIL)
    expect(res.user.isAdmin).toBe(true)
    token = res.accessToken
    refreshToken = res.refreshToken
  })

  it('login with wrong password rejects', async () => {
    await expect(devLogin(ADMIN_LOGIN, 'wrong')).rejects.toThrow()
  })

  it('refresh returns new tokens (the refresh token rotates)', async () => {
    const res = await root.api.auth.refresh(refreshToken)
    expect(res.accessToken).toBeTruthy()
    expect(res.refreshToken).not.toBe(refreshToken)
    token = res.accessToken
    refreshToken = res.refreshToken
  })

  it('logout revokes the refresh token', async () => {
    await expect(root.api.auth.logout(token, refreshToken)).resolves.not.toThrow()
    await expect(root.api.auth.refresh(refreshToken)).rejects.toThrow()
  })
})
