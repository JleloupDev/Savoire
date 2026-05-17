// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { makeAppRoot } from './helpers/makeAppRoot'

const ADMIN_EMAIL = 'admin@local.dev'
const ADMIN_PASSWORD = 'Admin1234!'

describe('Vaults — via Application layer', () => {
  let token = ''
  let userId = ''
  let vaultId = ''
  const root = makeAppRoot(() => token)

  beforeAll(async () => {
    const res = await root.api.auth.login(ADMIN_EMAIL, ADMIN_PASSWORD)
    token = res.accessToken
    userId = res.user.id
  })

  afterAll(async () => {
    if (vaultId) await root.api.vaults.delete(vaultId, token).catch(() => {})
  })

  it('list returns workspace with vaults and shared notes', async () => {
    const ws = await root.api.vaults.list(userId, token)
    expect(ws).toHaveProperty('vaults')
    expect(ws).toHaveProperty('sharedWithMe')
    expect(Array.isArray(ws.vaults)).toBe(true)
  })

  it('create returns new vault summary', async () => {
    const vault = await root.api.vaults.create(userId, 'Test Vault', token)
    expect(vault.id).toBeTruthy()
    expect(vault.name).toBe('Test Vault')
    vaultId = vault.id
  })

  it('list includes the created vault', async () => {
    const ws = await root.api.vaults.list(userId, token)
    expect(ws.vaults.some(v => v.id === vaultId)).toBe(true)
  })

  it('rename updates vault name', async () => {
    const renamed = await root.api.vaults.rename(vaultId, 'Renamed Vault', token)
    expect(renamed.name).toBe('Renamed Vault')
  })

  it('delete removes the vault', async () => {
    await expect(root.api.vaults.delete(vaultId, token)).resolves.not.toThrow()
    const ws = await root.api.vaults.list(userId, token)
    expect(ws.vaults.some(v => v.id === vaultId)).toBe(false)
    vaultId = ''
  })
})
