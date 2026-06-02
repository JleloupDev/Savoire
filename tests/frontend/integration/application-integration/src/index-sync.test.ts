// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { IDocumentMeta } from '@savoire/platform'
import { makeAppRoot } from './helpers/makeAppRoot'
import { makeVaultHub } from './helpers/makeVaultHub'
import { writeYjsContent } from './helpers/writeYjsContent'

const ADMIN_EMAIL = 'admin@local.dev'
const ADMIN_PASSWORD = 'Admin1234!'
const GUEST_EMAIL = `index-guest-${Date.now()}@local.dev`
const GUEST_PASSWORD = 'Guest12345!'

describe('Index sync — fulltext propagation between clients', () => {
  let adminToken = ''
  let adminUserId = ''
  let guestToken = ''
  let guestUserId = ''
  let vaultId = ''
  let doc: IDocumentMeta

  const adminRoot = makeAppRoot(() => adminToken)
  const guestRoot = makeAppRoot(() => guestToken)

  beforeAll(async () => {
    const adminRes = await adminRoot.api.auth.login(ADMIN_EMAIL, ADMIN_PASSWORD)
    adminToken = adminRes.accessToken
    adminUserId = adminRes.user.id

    await adminRoot.api.admin.createUser(adminToken, GUEST_EMAIL, GUEST_PASSWORD, 'Index Guest', false)
    const users = await adminRoot.api.admin.listUsers(adminToken)
    guestUserId = users.find(u => u.email === GUEST_EMAIL)!.id

    const guestRes = await guestRoot.api.auth.login(GUEST_EMAIL, GUEST_PASSWORD)
    guestToken = guestRes.accessToken

    const vault = await adminRoot.api.vaults.create(adminUserId, 'Index Test Vault', adminToken)
    vaultId = vault.id

    const hub = await makeVaultHub(vaultId, () => adminToken)
    doc = await hub.createDocument('indexed-note.md')
    await hub.dispose()

    await adminRoot.api.sharing.grantPermission('vault', vaultId, guestUserId, 'read', adminToken)
  })

  afterAll(async () => {
    if (vaultId) await adminRoot.api.vaults.delete(vaultId, adminToken).catch(() => {})
    if (guestUserId) await adminRoot.api.admin.disableUser(adminToken, guestUserId).catch(() => {})
  })

  it('admin pushes an index op — guest receives it via onIndexOpApplied', async () => {
    const adminHub = await makeVaultHub(vaultId, () => adminToken)
    const guestHub = await makeVaultHub(vaultId, () => guestToken)

    const received: { seq: number; docId: string; path: string; markdownContent: string }[] = []

    // Guest subscribes to index ops
    const unsubscribe = guestHub.hub.onIndexOpApplied!((evt) => {
      received.push(evt)
    })

    // Write document content first so there are Yjs ops
    await writeYjsContent(vaultId, doc.id, '# Searchable content\n\nkeyword: savoire', () => adminToken, adminUserId)

    // Admin pushes an index op for this document
    const seq = await adminHub.hub.pushIndexOp!(doc.id, doc.path, '# Searchable content\n\nkeyword: savoire')
    expect(seq).toBeGreaterThan(0)

    // Give SignalR a moment to broadcast
    await new Promise(r => setTimeout(r, 300))

    unsubscribe()
    await adminHub.dispose()
    await guestHub.dispose()

    // Guest should have received the index op
    const op = received.find(e => e.docId === doc.id)
    expect(op).toBeTruthy()
    expect(op!.markdownContent).toContain('savoire')
    expect(op!.seq).toBe(seq)
  })

  it('index op carries correct path and seq', async () => {
    const adminHub = await makeVaultHub(vaultId, () => adminToken)

    const content = '# Another doc\n\n#hashtag backlink [[other]]'
    const seq = await adminHub.hub.pushIndexOp!(doc.id, doc.path, content)

    expect(typeof seq).toBe('number')
    expect(seq).toBeGreaterThan(0)

    await adminHub.dispose()
  })

  it('seq is monotonically increasing across consecutive pushes', async () => {
    const adminHub = await makeVaultHub(vaultId, () => adminToken)
    const seq1 = await adminHub.hub.pushIndexOp!(doc.id, doc.path, 'first push')
    const seq2 = await adminHub.hub.pushIndexOp!(doc.id, doc.path, 'second push')
    const seq3 = await adminHub.hub.pushIndexOp!(doc.id, doc.path, 'third push')
    await adminHub.dispose()

    expect(seq1).toBeGreaterThan(0)
    expect(seq2).toBeGreaterThan(seq1!)
    expect(seq3).toBeGreaterThan(seq2!)
  })

  it('guest hub receives ops from admin without prior knowledge of the content', async () => {
    const adminHub = await makeVaultHub(vaultId, () => adminToken)
    const guestHub2 = await makeVaultHub(vaultId, () => guestToken)

    const received: { seq: number; docId: string; path: string; markdownContent: string }[] = []
    const unsub = guestHub2.hub.onIndexOpApplied!((evt) => received.push(evt))

    const content = '# Fresh content for guest index'
    await adminHub.hub.pushIndexOp!(doc.id, doc.path, content)

    await new Promise(r => setTimeout(r, 300))

    unsub()
    await adminHub.dispose()
    await guestHub2.dispose()

    expect(received.some(e => e.markdownContent.includes('Fresh content'))).toBe(true)
  })
})
