// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { IDocumentMeta } from '@savoire/platform'
import { makeAppRoot, makeCrdtAppRoot } from './helpers/makeAppRoot'
import { makeVaultHub } from './helpers/makeVaultHub'
import { writeYjsContent } from './helpers/writeYjsContent'

const ADMIN_EMAIL = 'admin@local.dev'
const ADMIN_PASSWORD = 'Admin1234!'
const GUEST_EMAIL = `editing-guest-${Date.now()}@local.dev`
const GUEST_PASSWORD = 'Guest12345!'

// Shared setup between the two describe blocks
let adminToken = ''
let adminUserId = ''
let guestToken = ''
let guestUserId = ''
let vaultId = ''
let docMeta: IDocumentMeta

const adminRoot = makeAppRoot(() => adminToken)
const guestRoot = makeAppRoot(() => guestToken)

async function setupEditing() {
  const adminRes = await adminRoot.api.auth.login(ADMIN_EMAIL, ADMIN_PASSWORD)
  adminToken = adminRes.accessToken
  adminUserId = adminRes.user.id

  await adminRoot.api.admin.createUser(adminToken, GUEST_EMAIL, GUEST_PASSWORD, 'Editing Guest', false)
  const users = await adminRoot.api.admin.listUsers(adminToken)
  guestUserId = users.find(u => u.email === GUEST_EMAIL)!.id

  const guestRes = await guestRoot.api.auth.login(GUEST_EMAIL, GUEST_PASSWORD)
  guestToken = guestRes.accessToken

  const vault = await adminRoot.api.vaults.create(adminUserId, 'Editing Test Vault', adminToken)
  vaultId = vault.id

  const vaultHub = await makeVaultHub(vaultId, () => adminToken)
  docMeta = await vaultHub.createDocument('collab-note.md')
  await vaultHub.dispose()

  await writeYjsContent(vaultId, docMeta.id, '# Hello from Admin', () => adminToken, adminUserId)
  await adminRoot.api.sharing.grantPermission('vault', vaultId, guestUserId, 'read', adminToken)
}

async function teardownEditing() {
  if (vaultId) await adminRoot.api.vaults.delete(vaultId, adminToken).catch(() => {})
  if (guestUserId) await adminRoot.api.admin.disableUser(adminToken, guestUserId).catch(() => {})
}

describe('Editing & Share Link — via Application layer', () => {
  beforeAll(setupEditing)
  afterAll(teardownEditing)

  describe('CRDT collaboration', () => {
    it('guest reads document content written by admin via CRDT path', async () => {
      const guestCrdtRoot = makeCrdtAppRoot(() => guestToken, () => guestUserId)
      const content = await guestCrdtRoot.api.documentSession.read(vaultId, docMeta.id, guestToken)
      expect(content).toBe('# Hello from Admin')
    })

    it('admin reads own document via CRDT path', async () => {
      const adminCrdtRoot = makeCrdtAppRoot(() => adminToken, () => adminUserId)
      const content = await adminCrdtRoot.api.documentSession.read(vaultId, docMeta.id, adminToken)
      expect(content).toBe('# Hello from Admin')
    })

    it('document appears in the CRDT directory for a shared guest', async () => {
      const guestHub = await makeVaultHub(vaultId, () => guestToken, guestUserId)
      const seen = await guestHub.waitFor(docs => docs.some(d => d.id === docMeta.id))
      expect(seen).toBe(true)
      await guestHub.dispose()
    })
  })

  describe('Document share link', () => {
    let readLinkToken = ''
    let readAccessToken = ''
    let writeDoc: IDocumentMeta

    it('admin creates a read share link for a document', async () => {
      const link = await adminRoot.api.sharing.createShareLink('document', docMeta.id, 'read', adminToken)
      expect(link.isValid).toBe(true)
      readLinkToken = link.token
    })

    it('redeeming the link returns document-level metadata', async () => {
      const access = await adminRoot.api.sharing.accessShareLink(readLinkToken)
      expect(access.resourceType).toBe('document')
      expect(access.resourceId).toBe(docMeta.id)
      expect(access.permission).toBe('read')
      readAccessToken = access.accessToken
      // A document link is addressed by docId: vaultId is not required for the
      // CRDT path (content + access are docId-scoped). Resolving it is an ACL concern.
    })

    it('share link access token allows reading via CRDT path', async () => {
      // End-to-end from the link holder's perspective: token + docId only, no vaultId.
      const anonCrdtRoot = makeCrdtAppRoot(() => readAccessToken, () => `share-link`)
      const content = await anonCrdtRoot.api.documentSession.read('', docMeta.id, readAccessToken)
      expect(content).toBe('# Hello from Admin')
    })

    it('write share link allows pushing Yjs ops and content is readable', async () => {
      const vaultHub = await makeVaultHub(vaultId, () => adminToken)
      writeDoc = await vaultHub.createDocument('link-write-test.md')
      await vaultHub.dispose()

      const link = await adminRoot.api.sharing.createShareLink('document', writeDoc.id, 'write', adminToken)
      const access = await adminRoot.api.sharing.accessShareLink(link.token)
      expect(access.permission).toBe('write')

      // Document link: write content by docId via the share token (no vaultId).
      await writeYjsContent('', writeDoc.id, '# Written via link', () => access.accessToken, 'share-link')

      const adminCrdtRoot = makeCrdtAppRoot(() => adminToken, () => adminUserId)
      const content = await adminCrdtRoot.api.documentSession.read(vaultId, writeDoc.id, adminToken)
      expect(content).toBe('# Written via link')
    })
  })

}) // end: Editing & Share Link
