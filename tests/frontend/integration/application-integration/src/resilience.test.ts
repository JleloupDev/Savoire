// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { IDocumentMeta } from '@savoire/platform'
import { makeAppRoot, makeCrdtAppRoot } from './helpers/makeAppRoot'
import { makeVaultHub } from './helpers/makeVaultHub'
import { writeYjsContent } from './helpers/writeYjsContent'

const ADMIN_EMAIL = 'admin@local.dev'
const ADMIN_PASSWORD = 'Admin1234!'
const GUEST_EMAIL = `resilience-guest-${Date.now()}@local.dev`
const GUEST_PASSWORD = 'Guest12345!'

describe('Resilience — connection interruption during collaboration', () => {
  let adminToken = ''
  let adminUserId = ''
  let guestToken = ''
  let guestUserId = ''
  let vaultId = ''
  let docA: IDocumentMeta
  let docB: IDocumentMeta

  const adminRoot = makeAppRoot(() => adminToken)
  const guestRoot = makeAppRoot(() => guestToken)

  beforeAll(async () => {
    const adminRes = await adminRoot.api.auth.login(ADMIN_EMAIL, ADMIN_PASSWORD)
    adminToken = adminRes.accessToken
    adminUserId = adminRes.user.id

    await adminRoot.api.admin.createUser(adminToken, GUEST_EMAIL, GUEST_PASSWORD, 'Resilience Guest', false)
    const users = await adminRoot.api.admin.listUsers(adminToken)
    guestUserId = users.find(u => u.email === GUEST_EMAIL)!.id

    const guestRes = await guestRoot.api.auth.login(GUEST_EMAIL, GUEST_PASSWORD)
    guestToken = guestRes.accessToken

    const vault = await adminRoot.api.vaults.create(adminUserId, 'Resilience Test Vault', adminToken)
    vaultId = vault.id

    // Create two documents
    const hub = await makeVaultHub(vaultId, () => adminToken)
    docA = await hub.createDocument('doc-a.md')
    docB = await hub.createDocument('doc-b.md')
    await hub.dispose()

    await adminRoot.api.sharing.grantPermission('vault', vaultId, guestUserId, 'write', adminToken)
  })

  afterAll(async () => {
    if (vaultId) await adminRoot.api.vaults.delete(vaultId, adminToken).catch(() => {})
    if (guestUserId) await adminRoot.api.admin.disableUser(adminToken, guestUserId).catch(() => {})
  })

  it('concurrent writes from two clients — both contents are persisted', async () => {
    // Admin and guest push ops at the same time on separate documents
    await Promise.all([
      writeYjsContent(vaultId, docA.id, '# Admin writes docA', () => adminToken, adminUserId),
      writeYjsContent(vaultId, docB.id, '# Guest writes docB', () => guestToken, guestUserId),
    ])

    const adminCrdt = makeCrdtAppRoot(() => adminToken, () => adminUserId)
    const guestCrdt = makeCrdtAppRoot(() => guestToken, () => guestUserId)

    const [contentA, contentB] = await Promise.all([
      adminCrdt.api.documentSession.read(vaultId, docA.id, adminToken),
      guestCrdt.api.documentSession.read(vaultId, docB.id, guestToken),
    ])

    expect(contentA).toBe('# Admin writes docA')
    expect(contentB).toBe('# Guest writes docB')
  })

  it('client B disconnects mid-session — client A content still readable after reconnect', async () => {
    // Fresh doc so CRDT history is clean regardless of other tests
    const hub = await makeVaultHub(vaultId, () => adminToken)
    const disconnectDoc = await hub.createDocument('disconnect-test.md')
    await hub.dispose()

    await writeYjsContent(vaultId, disconnectDoc.id, '# Initial content', () => adminToken, adminUserId)

    // Client B reads before the interruption
    const guestCrdtBefore = makeCrdtAppRoot(() => guestToken, () => guestUserId)
    const before = await guestCrdtBefore.api.documentSession.read(vaultId, disconnectDoc.id, guestToken)
    expect(before).toBe('# Initial content')

    // Admin pushes new content while guest is "disconnected" (no active connection)
    await writeYjsContent(vaultId, disconnectDoc.id, '# Admin update while B was away', () => adminToken, adminUserId)

    // Guest reconnects — fresh CrdtDocumentFetcher receives full op history
    const guestCrdtAfter = makeCrdtAppRoot(() => guestToken, () => guestUserId)
    const after = await guestCrdtAfter.api.documentSession.read(vaultId, disconnectDoc.id, guestToken)

    expect(after).toContain('# Initial content')
    expect(after).toContain('# Admin update while B was away')
  })

  it('client B disconnects then reconnects — sees all ops including those written during absence', async () => {
    // Fresh doc for clean state
    const hub = await makeVaultHub(vaultId, () => adminToken)
    const freshDoc = await hub.createDocument('reconnect-test.md')
    await hub.dispose()

    // Admin writes initial content
    await writeYjsContent(vaultId, freshDoc.id, '# Initial', () => adminToken, adminUserId)

    // Guest connects and reads (first time — joins the document)
    const guestSession1 = makeCrdtAppRoot(() => guestToken, () => guestUserId)
    const content1 = await guestSession1.api.documentSession.read(vaultId, freshDoc.id, guestToken)
    expect(content1).toBe('# Initial')

    // Admin writes more while guest session is gone (session1 disposed implicitly by GC)
    await writeYjsContent(vaultId, freshDoc.id, ' — appended', () => adminToken, adminUserId)

    // Guest reconnects with a new session — receives full op history from server
    const guestSession2 = makeCrdtAppRoot(() => guestToken, () => guestUserId)
    const content2 = await guestSession2.api.documentSession.read(vaultId, freshDoc.id, guestToken)

    // CRDT merges all ops: initial + appended both present
    expect(content2).toContain('# Initial')
    expect(content2).toContain('— appended')
  })

  it('concurrent writes from two clients on the SAME document are both preserved by CRDT', async () => {
    const hub = await makeVaultHub(vaultId, () => adminToken)
    const sameDoc = await hub.createDocument('same-doc-concurrent.md')
    await hub.dispose()

    await Promise.all([
      writeYjsContent(vaultId, sameDoc.id, 'alpha-unique-admin', () => adminToken, adminUserId),
      writeYjsContent(vaultId, sameDoc.id, 'beta-unique-guest',  () => guestToken,  guestUserId),
    ])

    const crdt = makeCrdtAppRoot(() => adminToken, () => adminUserId)
    const content = await crdt.api.documentSession.read(vaultId, sameDoc.id, adminToken)
    expect(content).toContain('alpha-unique-admin')
    expect(content).toContain('beta-unique-guest')
  })

  it('admin revokes access mid-session — guest can no longer read', async () => {
    // Grant then immediately revoke
    await adminRoot.api.sharing.grantPermission('vault', vaultId, guestUserId, 'read', adminToken)
    await adminRoot.api.sharing.revokePermission('vault', vaultId, guestUserId, adminToken)

    // Guest tries to read after revocation
    const guestCrdt = makeCrdtAppRoot(() => guestToken, () => guestUserId)
    await expect(
      guestCrdt.api.documentSession.read(vaultId, docA.id, guestToken)
    ).rejects.toThrow()
  })
})
