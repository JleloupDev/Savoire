// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// VaultClient avec une session de vault : tout le contenu passe par elle. Le
// connecteur local (sans serveur) le prouve : deux pairs s'echangent dessins,
// tableaux, notes et pieces jointes par la seule session.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { DocumentStore, VaultClient, subscribeUploads, type DocumentSyncKind, type IVaultStorage, type UploadEvent } from '@savoire/platform'
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

  it('un type declare crdt par son plugin se lit depuis son CRDT, quelle que soit l\'extension', async () => {
    const syncKindOf = (path: string): DocumentSyncKind => (path.endsWith('.md') || path.endsWith('.wtf') ? 'crdt' : 'snapshot')
    const alice = await peer('alice')
    const bobSession = await factory.open({ vaultId: 'v1', token: '', userId: 'bob', onChanged: () => {} })
    sessions.push(bobSession)
    const bob = new VaultClient('v1', '', forbiddenStorage(), forbiddenStore(), bobSession.directory, () => undefined, bobSession, syncKindOf)
    await alice.client.createFile('note.wtf')
    const id = alice.client.resolveDocumentId('note.wtf')!
    const doc = (alice.session.openDocument(id) as YjsCrdtAdapter).rawDoc as { getText(n: string): { insert(i: number, t: string): void } }
    doc.getText('codemirror').insert(0, 'wtf !')
    await settle()
    expect(await bob.readDocumentByPath('note.wtf')).toBe('wtf !')
  })

  it('creer un document l\'inscrit d\'abord aupres de la session ; un refus annule la creation', async () => {
    const alice = await peer('alice')
    const order: string[] = []
    const real = alice.session.registerDocuments.bind(alice.session)
    alice.session.registerDocuments = async (ids) => { order.push(`register:${ids.length}`); await real(ids) }
    alice.client.onChange(() => order.push('directory'))
    await alice.client.createFile('inscrite.md')
    expect(order.slice(0, 2)).toEqual(['register:1', 'directory'])

    alice.session.registerDocuments = async () => { throw new Error('refuse') }
    await expect(alice.client.createFile('refusee.md')).rejects.toThrow('refuse')
    expect(alice.client.resolveDocumentId('refusee.md')).toBeUndefined()
  })

  it('une piece jointe passe par la session', async () => {
    const alice = await peer('alice')
    const bob = await peer('bob')
    const path = await alice.client.uploadAttachment(new File(['abc'], 'a.txt', { type: 'text/plain' }))
    await settle()
    expect(path.startsWith('attachments/')).toBe(true)
    expect(await bob.client.resolveAttachmentUrl(path)).not.toBe('')
    expect(await bob.client.readDocumentByPath(path)).toBe('abc')
  })

  it('une image garde son nom d\'origine, suffixe en cas de collision, et se resout par son nom chez l\'autre pair', async () => {
    const alice = await peer('alice')
    const bob = await peer('bob')
    const png = () => new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'Photo.png', { type: 'image/png' })
    const first = await alice.client.uploadAttachment(png())
    const second = await alice.client.uploadAttachment(png())
    await settle()
    expect(first).toBe('attachments/Photo.png')
    expect(second).toBe('attachments/Photo 1.png')
    // Nom unique dans le vault : le lien se contente du nom, comme Obsidian.
    expect(bob.client.linkTarget(second)).toBe('Photo 1.png')
    expect(await bob.client.resolveAttachmentUrl('Photo 1.png')).toMatch(/^blob:/)
    expect(await bob.client.resolveAttachmentUrl('attachments/Photo.png')).toMatch(/^blob:/)
  })

  it('renommer une image ne la casse pas : les octets suivent l\'id du document', async () => {
    const alice = await peer('alice')
    const bob = await peer('bob')
    const path = await alice.client.uploadAttachment(new File(['img'], 'Avant.png', { type: 'image/png' }))
    const id = alice.client.resolveDocumentId(path)!
    await alice.client.renameFile(id, 'attachments/Apres.png')
    await settle()
    expect(await bob.client.readDocumentByPath('Apres.png')).toBe('img')
  })

  it('un nom present dans deux dossiers se lie par son chemin', async () => {
    const alice = await peer('alice')
    alice.client.addDocument({ id: 'x', path: 'autre/Photo.png' })
    const path = await alice.client.uploadAttachment(new File(['p'], 'Photo.png', { type: 'image/png' }))
    expect(alice.client.linkTarget(path)).toBe('attachments/Photo.png')
  })

  // ── Images rangees avec leur note ─────────────────────────────────────────

  const png = (name = 'Photo.png') => new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], name, { type: 'image/png' })

  it('envoyee depuis une note, l\'image va dans le dossier de la note et se lit chez l\'autre pair', async () => {
    const alice = await peer('alice')
    const bob = await peer('bob')
    await alice.client.createFile('Dossier/Ma note.md')
    const path = await alice.client.uploadAttachment(png(), { notePath: 'Dossier/Ma note.md' })
    await settle()
    expect(path).toBe('Dossier/Ma note/Photo.png')
    expect(alice.client.linkTarget(path)).toBe('Photo.png')
    // Le dossier de la note apparait sous la note (convention note de dossier).
    expect(await bob.client.list('Dossier')).toEqual(['Dossier/Ma note.md', 'Dossier/Ma note/'])
    expect(await bob.client.resolveAttachmentUrl('Photo.png')).toMatch(/^blob:/)
  })

  it('meme nom dans deux notes : suffixe dans chaque dossier, lien par chemin quand le nom est ambigu', async () => {
    const alice = await peer('alice')
    await alice.client.createFile('A.md')
    await alice.client.createFile('B.md')
    const a = await alice.client.uploadAttachment(png(), { notePath: 'A.md' })
    const a2 = await alice.client.uploadAttachment(png(), { notePath: 'A.md' })
    const b = await alice.client.uploadAttachment(png(), { notePath: 'B.md' })
    expect([a, a2, b]).toEqual(['A/Photo.png', 'A/Photo 1.png', 'B/Photo.png'])
    expect(alice.client.linkTarget(b)).toBe('B/Photo.png')
    expect(alice.client.linkTarget(a2)).toBe('Photo 1.png')
  })

  it('sans note (depot dans l\'arborescence), l\'image va toujours dans attachments/', async () => {
    const alice = await peer('alice')
    expect(await alice.client.uploadAttachment(png())).toBe('attachments/Photo.png')
  })

  it('chaque envoi est annonce : en cours, puis succes ; un echec donne le nom et la raison', async () => {
    const alice = await peer('alice')
    const events: UploadEvent[] = []
    const unsub = subscribeUploads(e => events.push(e))
    await alice.client.createFile('Note.md')
    await alice.client.uploadAttachment(png('Ok.png'), { notePath: 'Note.md' })
    alice.session.files.upload = async () => { throw new Error('500') }
    await expect(alice.client.uploadAttachment(png('Rate.png'), { notePath: 'Note.md' })).rejects.toThrow('500')
    unsub()
    expect(events.map(e => [e.kind, e.fileName])).toEqual([
      ['progress', 'Ok.png'], ['done', 'Ok.png'], ['progress', 'Rate.png'], ['error', 'Rate.png'],
    ])
    expect(events[0]).toMatchObject({ fraction: null })
    expect(events[1]).toMatchObject({ path: 'Note/Ok.png' })
    expect(events[3]).toMatchObject({ reason: 'erreur du serveur' })
    // L'image ratee n'apparait pas dans le vault.
    expect(alice.client.resolveDocumentId('Note/Rate.png')).toBeUndefined()
  })

  it('le rangement est annonce (partage de la note) a l\'envoi, puis quand l\'image change de dossier', async () => {
    const alice = await peer('alice')
    const place = vi.fn(async () => {})
    alice.session.files.place = place
    await alice.client.createFile('Projet.md')
    const noteId = alice.client.resolveDocumentId('Projet.md')!
    const path = await alice.client.uploadAttachment(png(), { notePath: 'Projet.md' })
    const imageId = alice.client.resolveDocumentId(path)!
    await settle()
    expect(place).toHaveBeenCalledWith(imageId, { noteId, name: 'Photo.png' })

    // Deplacer la note et son dossier : le contenu d'abord, la note ensuite.
    place.mockClear()
    await alice.client.renameFile(imageId, 'Archives/Projet/Photo.png')
    await alice.client.renameFile(noteId, 'Archives/Projet.md')
    await alice.client.flushPlacements()
    expect(place).toHaveBeenCalledWith(imageId, { noteId, name: 'Photo.png' })

    // Sortie du dossier : plus rangee avec la note.
    place.mockClear()
    await alice.client.renameFile(imageId, 'attachments/Photo.png')
    await alice.client.flushPlacements()
    expect(place).toHaveBeenCalledWith(imageId, { noteId: null, name: 'Photo.png' })
  })

  it('un echec de l\'annonce du rangement ne gache pas l\'envoi', async () => {
    const alice = await peer('alice')
    alice.session.files.place = async () => { throw new Error('403') }
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await alice.client.createFile('N.md')
    expect(await alice.client.uploadAttachment(png(), { notePath: 'N.md' })).toBe('N/Photo.png')
    await settle()
    warn.mockRestore()
  })
})
