// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// VaultClient avec une session de vault : tout le contenu passe par elle. Le
// connecteur local (sans serveur) le prouve : deux pairs s'echangent dessins,
// tableaux, notes et pieces jointes par la seule session.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { DocumentStore, VaultClient, type IVaultStorage } from '@savoire/platform'
import type { IVaultSyncSession } from '@savoire/application'
import { InProcessPeerBus, LocalPeerVaultSessionFactory, type YjsCrdtAdapter } from '@savoire/infrastructure-sync'

const SETTLE_MS = 5
const settle = () => new Promise(r => setTimeout(r, SETTLE_MS * 4))

/** Le VaultClient d'un vault ne doit JAMAIS toucher ce stockage direct. */
function forbiddenStorage(): IVaultStorage {
  const fail = vi.fn(() => { throw new Error('stockage direct appele') })
  return { readFile: fail, writeFile: fail, resolveFileUrl: fail, listDocuments: fail, uploadAttachment: fail }
}

function forbiddenStore(): DocumentStore {
  const fail = vi.fn(async () => { throw new Error('documentStore appele') })
  return new DocumentStore({ getDocumentContent: fail, writeDocumentContent: fail })
}

describe('VaultClient sur une session de vault', () => {
  const factory = new LocalPeerVaultSessionFactory(new InProcessPeerBus(), { settleMs: SETTLE_MS })
  const sessions: IVaultSyncSession[] = []

  async function peer(userId: string): Promise<{ client: VaultClient; session: IVaultSyncSession }> {
    const session = await factory.open({ vaultId: 'v1', token: '', userId, onChanged: () => {} })
    sessions.push(session)
    const client = new VaultClient('v1', '', forbiddenStorage(), forbiddenStore(), session.directory, () => undefined, session)
    return { client, session }
  }

  afterEach(async () => {
    for (const s of sessions.splice(0)) await s.dispose()
  })

  it('un document snapshot ecrit par un pair se relit chez l\'autre', async () => {
    const alice = await peer('alice')
    const bob = await peer('bob')
    await alice.client.createFile('dessin.excalidraw')
    const id = alice.client.resolveDocumentId('dessin.excalidraw')!
    await alice.client.write(id, '{"elements":[]}')
    await settle()
    expect(await bob.client.readDocumentByPath('dessin.excalidraw')).toBe('{"elements":[]}')
    expect(await bob.client.read(id)).toBe('{"elements":[]}')
  })

  it('l\'ecriture par vault.write arrive aux vues ouvertes sur le document', async () => {
    const alice = await peer('alice')
    const bob = await peer('bob')
    await alice.client.createFile('t.table')
    await settle()
    const id = bob.client.resolveDocumentId('t.table')!
    const view = bob.session.openSnapshot(id)
    await view.load()
    const received: string[] = []
    view.onRemoteWrite(content => received.push(content))
    await alice.client.write(id, '| a |')
    await settle()
    expect(received).toEqual(['| a |'])
  })

  it('une note markdown se lit depuis son CRDT', async () => {
    const alice = await peer('alice')
    const bob = await peer('bob')
    await alice.client.createFile('note')
    const id = alice.client.resolveDocumentId('note.md')!
    const doc = (alice.session.openDocument(id) as YjsCrdtAdapter).rawDoc as { getText(n: string): { insert(i: number, t: string): void } }
    doc.getText('codemirror').insert(0, '# Titre')
    await settle()
    expect(await bob.client.readDocumentByPath('note.md')).toBe('# Titre')
  })

  it('une piece jointe passe par la session', async () => {
    const alice = await peer('alice')
    const bob = await peer('bob')
    const path = await alice.client.uploadAttachment(new File(['abc'], 'a.txt', { type: 'text/plain' }))
    await settle()
    expect(path.startsWith('attachments/')).toBe(true)
    expect(bob.client.resolveAttachmentUrl(path)).not.toBe('')
    expect(await bob.client.readDocumentByPath(path)).toBe('abc')
  })

})
