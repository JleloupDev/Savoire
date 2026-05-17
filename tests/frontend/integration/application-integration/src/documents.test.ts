// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { makeAppRoot } from './helpers/makeAppRoot'

const ADMIN_EMAIL = 'admin@local.dev'
const ADMIN_PASSWORD = 'Admin1234!'

// Note: document creation/rename/delete require a live SignalR hub and are tested
// via VaultHubClient in the collaboration tests. These tests cover the REST-backed
// operations available without an active hub connection.

describe('Documents — via Application layer', () => {
  let token = ''
  let userId = ''
  let vaultId = ''
  const root = makeAppRoot(() => token)

  beforeAll(async () => {
    const res = await root.api.auth.login(ADMIN_EMAIL, ADMIN_PASSWORD)
    token = res.accessToken
    userId = res.user.id

    const vault = await root.api.vaults.create(userId, 'Documents Test Vault', token)
    vaultId = vault.id
  })

  afterAll(async () => {
    if (vaultId) await root.api.vaults.delete(vaultId, token).catch(() => {})
  })

  it('list returns empty array for a new vault', async () => {
    const docs = await root.api.documents.list(vaultId, token)
    expect(Array.isArray(docs)).toBe(true)
    expect(docs).toHaveLength(0)
  })
})
