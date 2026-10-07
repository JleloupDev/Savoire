// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Contrat commun de IVaultSyncSession. Tout connecteur (local, EdgeSync,
// automerge-repo...) doit le passer. Il decrit ce que l'application attend de
// la session, et rien de plus : pas d'hypothese sur le serveur.
//
// Les verrous sont une capacite optionnelle : ils ne sont pas testes ici.
import { describe, it, expect, afterEach } from 'vitest'
import type { IVaultSyncSession } from '@savoire/application'
import type { ICRDT } from '@savoire/plugin-api'

export interface VaultSyncSessionHarness {
  /** Ouvre une session sur le vault partage du test, comme un nouveau pair. */
  open(userId: string): Promise<IVaultSyncSession>
  /** Laisse le reseau du connecteur s'apaiser. */
  settle(): Promise<void>
  /** Ecrit du texte dans un document CRDT, comme le ferait l'editeur. */
  insertText(crdt: ICRDT, index: number, text: string): void
  /** Nouveau vault pour chaque test. */
  reset(): void
}

export function describeVaultSyncSessionContract(name: string, harness: VaultSyncSessionHarness): void {
  describe(`contrat IVaultSyncSession — ${name}`, () => {
    const opened: IVaultSyncSession[] = []
    const open = async (userId: string): Promise<IVaultSyncSession> => {
      const s = await harness.open(userId)
      opened.push(s)
      return s
    }

    afterEach(async () => {
      for (const s of opened.splice(0)) await s.dispose()
      harness.reset()
    })

    describe('repertoire', () => {
      it('une note creee par un pair apparait chez l\'autre', async () => {
        const a = await open('alice')
        const b = await open('bob')
        a.directory.add({ id: 'n1', path: 'note.md' })
        await harness.settle()
        expect(b.directory.getById('n1')).toEqual({ id: 'n1', path: 'note.md' })
      })

      it('un pair qui arrive recoit les notes et dossiers existants', async () => {
        const a = await open('alice')
        a.directory.add({ id: 'n1', path: 'dossier/note.md' })
        a.directory.addFolder('dossier/')
        await harness.settle()
        const b = await open('bob')
        await harness.settle()
        expect(b.directory.getAll()).toEqual([{ id: 'n1', path: 'dossier/note.md' }])
        expect(b.directory.getFolders()).toEqual(['dossier/'])
      })
    })

    describe('documents CRDT', () => {
      it('openDocument est idempotent', async () => {
        const a = await open('alice')
        expect(a.openDocument('d1')).toBe(a.openDocument('d1'))
      })

      it('le texte saisi par un pair converge chez l\'autre', async () => {
        const a = await open('alice')
        const b = await open('bob')
        const docA = a.openDocument('d1')
        b.openDocument('d1')
        harness.insertText(docA, 0, 'bonjour')
        await harness.settle()
        expect(await b.readDocument('d1', 'crdt')).toBe('bonjour')
      })

      it('un document ouvert tard recoit l\'etat des pairs en ligne', async () => {
        const a = await open('alice')
        harness.insertText(a.openDocument('d1'), 0, 'deja la')
        await harness.settle()
        const b = await open('bob')
        b.openDocument('d1')
        await harness.settle()
        expect(await b.readDocument('d1', 'crdt')).toBe('deja la')
      })

      it('un CRDT est rendu vide, son etat connu arrive ensuite comme un changement', async () => {
        const a = await open('alice')
        harness.insertText(a.openDocument('d1'), 0, 'deja la')
        await harness.settle()
        const b = await open('bob')
        await b.readDocument('d1', 'crdt')
        // L'etat est desormais connu de b. L'editeur le verrait-il ?
        const crdt = b.openDocument('d1')
        const seen: string[] = []
        crdt.onTextChange(text => seen.push(text.toString()))
        expect(seen).toEqual([])
        await harness.settle()
        expect(seen.at(-1)).toBe('deja la')
      })

      it('readDocument lit un document que ce pair n\'a jamais ouvert', async () => {
        const a = await open('alice')
        harness.insertText(a.openDocument('d1'), 0, 'embed')
        await harness.settle()
        const b = await open('bob')
        expect(await b.readDocument('d1', 'crdt')).toBe('embed')
      })
    })

    describe('documents snapshot', () => {
      it('un document jamais ecrit se charge a null et se lit vide', async () => {
        const a = await open('alice')
        const doc = a.openSnapshot('s1')
        expect(await doc.load()).toBeNull()
        a.closeSnapshot('s1')
        expect(await a.readDocument('s1', 'snapshot')).toBe('')
      })

      it('une ecriture arrive chez les pairs qui ont le document ouvert', async () => {
        const a = await open('alice')
        const b = await open('bob')
        const docA = a.openSnapshot('s1')
        const docB = b.openSnapshot('s1')
        await Promise.all([docA.load(), docB.load()])
        const received: [string, string][] = []
        const ownEchoes: string[] = []
        docB.onRemoteWrite((content, from) => received.push([content, from]))
        docA.onRemoteWrite(content => ownEchoes.push(content))
        await docA.write('{"v":1}')
        await harness.settle()
        expect(received).toEqual([['{"v":1}', 'alice']])
        expect(ownEchoes).toEqual([])
        expect(await docB.load()).toBe('{"v":1}')
      })

      it('un pair qui ouvre ensuite charge le dernier contenu', async () => {
        const a = await open('alice')
        const docA = a.openSnapshot('s1')
        await docA.load()
        await docA.write('v1')
        await docA.write('v2')
        await harness.settle()
        const b = await open('bob')
        expect(await b.openSnapshot('s1').load()).toBe('v2')
        expect(await b.readDocument('s1', 'snapshot')).toBe('v2')
      })

      it('la derniere ecriture gagne chez tout le monde', async () => {
        const a = await open('alice')
        const b = await open('bob')
        const docA = a.openSnapshot('s1')
        const docB = b.openSnapshot('s1')
        await Promise.all([docA.load(), docB.load()])
        await docA.write('alice')
        await harness.settle()
        await docB.write('bob')
        await harness.settle()
        expect(await docA.load()).toBe('bob')
        expect(await docB.load()).toBe('bob')
      })

      it('fermer une ouverture sur deux garde la synchro', async () => {
        const a = await open('alice')
        const b = await open('bob')
        const docB = b.openSnapshot('s1')
        b.openSnapshot('s1')
        b.closeSnapshot('s1')
        const received: string[] = []
        docB.onRemoteWrite(content => received.push(content))
        const docA = a.openSnapshot('s1')
        await docA.load()
        await docA.write('toujours la')
        await harness.settle()
        expect(received).toEqual(['toujours la'])
      })
    })

    describe('index', () => {
      it('une entree d\'index converge, y compris chez un pair qui arrive', async () => {
        const a = await open('alice')
        const b = await open('bob')
        const idxA = a.openIndex('tags')
        const idxB = b.openIndex('tags')
        idxA.set('d1', ['#a'])
        await harness.settle()
        expect(idxB.getAll()).toEqual([{ id: 'd1', value: ['#a'] }])

        const c = await open('carol')
        const idxC = c.openIndex('tags')
        await harness.settle()
        expect(idxC.getAll()).toEqual([{ id: 'd1', value: ['#a'] }])
      })

      it('openIndex est idempotent', async () => {
        const a = await open('alice')
        expect(a.openIndex('tags')).toBe(a.openIndex('tags'))
      })
    })

    describe('reglages du vault', () => {
      it('un reglage converge, y compris chez un pair qui arrive', async () => {
        const a = await open('alice')
        const b = await open('bob')
        const setA = a.openVaultSettings('plugins')
        const setB = b.openVaultSettings('plugins')
        setA.set('plugin-table', { enabled: false })
        await harness.settle()
        expect(setB.getAll()).toEqual([{ id: 'plugin-table', value: { enabled: false } }])

        const c = await open('carol')
        const setC = c.openVaultSettings('plugins')
        await harness.settle()
        expect(setC.getAll()).toEqual([{ id: 'plugin-table', value: { enabled: false } }])
      })

      it('deux membres qui changent deux cles differentes ne s\'ecrasent pas', async () => {
        const a = await open('alice')
        const b = await open('bob')
        const setA = a.openVaultSettings('plugins')
        const setB = b.openVaultSettings('plugins')
        await harness.settle()
        setA.set('plugin-table', { enabled: false })
        setB.set('plugin-mindmap', { enabled: false })
        await harness.settle()
        const ids = (s: typeof setA) => s.getAll().map(e => e.id).sort()
        expect(ids(setA)).toEqual(['plugin-mindmap', 'plugin-table'])
        expect(ids(setB)).toEqual(['plugin-mindmap', 'plugin-table'])
      })

      it('les reglages ne se melangent pas avec un index du meme nom', async () => {
        const a = await open('alice')
        a.openVaultSettings('tags').set('x', 1)
        expect(a.openIndex('tags').getAll()).toEqual([])
        expect(a.openVaultSettings('tags')).toBe(a.openVaultSettings('tags'))
      })
    })

    describe('pieces jointes', () => {
      it('un fichier envoye par un pair se lit et s\'affiche chez l\'autre', async () => {
        const a = await open('alice')
        const b = await open('bob')
        const { fileName, storagePath } = await a.files.upload(new File(['contenu'], 'notes.txt', { type: 'text/plain' }))
        await harness.settle()
        expect(fileName).toBe('notes.txt')
        expect(a.files.url(storagePath)).not.toBe('')
        expect(b.files.url(storagePath)).not.toBe('')
        expect(await b.files.read(storagePath)).toBe('contenu')
      })
    })

    describe('fin de session', () => {
      it('un pair qui part ne gene pas les autres', async () => {
        const a = await open('alice')
        const b = await harness.open('bob')
        await b.dispose()
        expect(b.getState()).toBe('disconnected')
        a.directory.add({ id: 'n1', path: 'note.md' })
        await harness.settle()
        const c = await open('carol')
        await harness.settle()
        expect(c.directory.getById('n1')).toEqual({ id: 'n1', path: 'note.md' })
      })
    })
  })
}
