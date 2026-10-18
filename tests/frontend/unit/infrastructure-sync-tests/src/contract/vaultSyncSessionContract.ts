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
import { DocumentStore, VaultClient, type IVaultStorage } from '@savoire/platform'
import type { ChangeOrigin, ICRDT, ITreeElement, ITreeText, TextDelta, TreeChangeInfo, TreeElementInit } from '@savoire/plugin-api'

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

    describe('inscription des documents', () => {
      it('inscrire des documents de ce vault reussit, et c\'est idempotent', async () => {
        const a = await open('alice')
        await a.registerDocuments(['d1', 'd2'])
        await a.registerDocuments(['d1'])
        await a.registerDocuments([])
      })
    })

    describe('cartes partagees', () => {
      it('une entree converge et reste separee des reglages et des index du meme nom', async () => {
        const a = await open('alice')
        const b = await open('bob')
        const mapA = a.openSharedMap('review')
        const mapB = b.openSharedMap('review')
        mapA.set('c1', { text: 'bonjour' })
        await harness.settle()
        expect(mapB.getAll()).toEqual([{ id: 'c1', value: { text: 'bonjour' } }])
        expect(a.openVaultSettings('review').getAll()).toEqual([])
        expect(a.openIndex('review').getAll()).toEqual([])
        expect(a.openSharedMap('review')).toBe(mapA)
      })
    })

    describe('ajout de texte', () => {
      it('le texte ajoute a un document ouvert arrive a la fin, chez tous', async () => {
        const a = await open('alice')
        const b = await open('bob')
        harness.insertText(a.openDocument('d1'), 0, 'debut')
        b.openDocument('d1')
        await harness.settle()
        b.appendText('d1', ' fin')
        await harness.settle()
        expect(await a.readDocument('d1', 'crdt')).toBe('debut fin')
      })

      it('refuse un document qui n\'est pas ouvert', async () => {
        const a = await open('alice')
        expect(() => a.appendText('jamais-ouvert', 'x')).toThrow('pas ouvert')
      })
    })

    describe('texte partage (ISharedText)', () => {
      type Seen = { delta: TextDelta; origin: ChangeOrigin }[]
      const record = (seen: Seen) => (delta: TextDelta, origin: ChangeOrigin) => { seen.push({ delta, origin }) }

      it('un pair ecrit, l\'autre recoit un delta distant et converge', async () => {
        const a = await open('alice')
        const b = await open('bob')
        a.openDocument('d1')
        b.openDocument('d1')
        const textA = a.openText('d1')
        const textB = b.openText('d1')
        await harness.settle()
        const seen: Seen = []
        textB.onChange(record(seen))
        textA.insert(0, 'bonjour')
        await harness.settle()
        expect(textB.toString()).toBe('bonjour')
        expect(textB.length).toBe(7)
        expect(seen).toEqual([{ delta: [{ insert: 'bonjour' }], origin: 'remote' }])
        expect(await b.readDocument('d1', 'crdt')).toBe('bonjour')
      })

      it('des ecritures concurrentes des deux cotes convergent', async () => {
        const a = await open('alice')
        const b = await open('bob')
        a.openDocument('d1')
        b.openDocument('d1')
        const textA = a.openText('d1')
        const textB = b.openText('d1')
        textA.insert(0, 'abc')
        await harness.settle()
        textA.applyDelta([{ retain: 1 }, { insert: 'X' }])
        textB.applyDelta([{ retain: 2 }, { delete: 1 }, { insert: 'Y' }])
        await harness.settle()
        expect(textA.toString()).toBe(textB.toString())
        expect(textA.toString()).toContain('X')
        expect(textA.toString()).toContain('Y')
        expect(textA.toString()).not.toContain('c')
      })

      it('ses propres ecritures arrivent en local, celles de l\'editeur aussi', async () => {
        const a = await open('alice')
        const crdt = a.openDocument('d1')
        const text = a.openText('d1')
        await harness.settle()
        const seen: Seen = []
        text.onChange(record(seen))
        text.insert(0, 'ab')
        text.delete(0, 1)
        harness.insertText(crdt, 1, 'c')
        expect(seen).toEqual([
          { delta: [{ insert: 'ab' }], origin: 'local' },
          { delta: [{ delete: 1 }], origin: 'local' },
          { delta: [{ retain: 1 }, { insert: 'c' }], origin: 'local' },
        ])
        expect(text.toString()).toBe('bc')
      })

      it('le contenu deja present arrive en distant apres l\'ouverture', async () => {
        const a = await open('alice')
        harness.insertText(a.openDocument('d1'), 0, 'deja la')
        await harness.settle()
        const b = await open('bob')
        b.openDocument('d1')
        const text = b.openText('d1')
        // Regle du port : vide a l'ouverture, l'etat arrive ensuite.
        expect(text.toString()).toBe('')
        const seen: Seen = []
        text.onChange(record(seen))
        await harness.settle()
        expect(text.toString()).toBe('deja la')
        expect(seen.length).toBeGreaterThan(0)
        expect(seen.every(s => s.origin === 'remote')).toBe(true)
      })

      it('openText est idempotent et refuse un document qui n\'est pas ouvert', async () => {
        const a = await open('alice')
        expect(() => a.openText('jamais-ouvert')).toThrow('pas ouvert')
        a.openDocument('d1')
        expect(a.openText('d1')).toBe(a.openText('d1'))
      })
    })

    describe('arbre partage (ISharedTree)', () => {
      const page: TreeElementInit = { kind: 'element', name: 'doc', children: [
        { kind: 'element', name: 'paragraph', children: [{ kind: 'text', delta: [{ insert: 'abc' }] }] },
      ] }

      it('un pair ecrit, l\'autre recoit un lot distant et converge', async () => {
        const a = await open('alice')
        const b = await open('bob')
        a.openDocument('d1')
        b.openDocument('d1')
        const treeA = a.openTree('d1')
        const treeB = b.openTree('d1')
        await harness.settle()
        const seen: TreeChangeInfo[] = []
        treeB.onChange((_c, info) => { seen.push(info) })
        treeA.root.set('doc', page)
        await harness.settle()
        expect(treeB.root.toJSON()).toEqual(treeA.root.toJSON())
        expect((treeB.root.get('doc') as ITreeElement).id).toBe((treeA.root.get('doc') as ITreeElement).id)
        expect(seen).toEqual([{ origin: 'remote' }])
      })

      it('des ecritures concurrentes dans l\'arbre convergent', async () => {
        const a = await open('alice')
        const b = await open('bob')
        a.openDocument('d1')
        b.openDocument('d1')
        const treeA = a.openTree('d1')
        const treeB = b.openTree('d1')
        treeA.root.set('doc', page)
        await harness.settle()
        const docA = treeA.root.get('doc') as ITreeElement
        const docB = treeB.root.get('doc') as ITreeElement
        ;((docA.get(0) as ITreeElement).get(0) as ITreeText).insert(1, 'X')
        ;((docB.get(0) as ITreeElement).get(0) as ITreeText).format(0, 3, { bold: true })
        docA.push([{ kind: 'element', name: 'paragraph' }])
        docB.insert(0, [{ kind: 'element', name: 'heading', attributes: { level: 1 } }])
        treeA.root.set('a', 1)
        treeB.root.set('b', 2)
        await harness.settle()
        expect(treeA.root.toJSON()).toEqual(treeB.root.toJSON())
        expect(docA.length).toBe(3)
        expect(treeA.root.keys().sort()).toEqual(['a', 'b', 'doc'])
      })

      it('ses propres ecritures arrivent en local, avec l\'etiquette', async () => {
        const a = await open('alice')
        a.openDocument('d1')
        const tree = a.openTree('d1')
        await harness.settle()
        const seen: TreeChangeInfo[] = []
        tree.onChange((_c, info) => { seen.push(info) })
        tree.root.set('x', 1)
        tree.transact(() => { tree.root.set('y', 2); tree.root.set('z', 3) }, 'miroir')
        expect(seen).toEqual([{ origin: 'local' }, { origin: 'local', tag: 'miroir' }])
      })

      it('l\'etat deja present arrive en distant apres l\'ouverture', async () => {
        const a = await open('alice')
        a.openDocument('d1')
        a.openTree('d1').root.set('doc', page)
        await harness.settle()
        const b = await open('bob')
        b.openDocument('d1')
        const tree = b.openTree('d1')
        // Regle du port : vide a l'ouverture, l'etat arrive ensuite.
        expect(tree.root.size).toBe(0)
        const seen: TreeChangeInfo[] = []
        tree.onChange((_c, info) => { seen.push(info) })
        await harness.settle()
        expect((tree.root.get('doc') as ITreeElement).toJSON()).toEqual({
          name: 'doc', attributes: {}, children: [{ name: 'paragraph', attributes: {}, children: ['abc'] }],
        })
        expect(seen.length).toBeGreaterThan(0)
        expect(seen.every(s => s.origin === 'remote')).toBe(true)
      })

      it('openTree est idempotent, refuse un document ferme, et ne touche pas au texte', async () => {
        const a = await open('alice')
        expect(() => a.openTree('jamais-ouvert')).toThrow('pas ouvert')
        a.openDocument('d1')
        expect(a.openTree('d1')).toBe(a.openTree('d1'))
        a.openTree('d1').root.set('k', 'v')
        expect(a.openText('d1').toString()).toBe('')
      })
    })

    describe('pieces jointes', () => {
      // Les octets sont ranges sous l'id du document ; le nom lisible vit
      // dans le repertoire. Aucune hypothese sur un serveur.
      it('un fichier envoye par un pair se lit et s\'affiche chez l\'autre', async () => {
        const a = await open('alice')
        const b = await open('bob')
        await a.files.upload('f1', new File(['contenu'], 'notes.txt', { type: 'text/plain' }))
        await harness.settle()
        expect(await a.files.url('f1')).not.toBe('')
        expect(await b.files.url('f1')).not.toBe('')
        expect(await b.files.read('f1')).toBe('contenu')
      })

      it('une image deposee garde son nom lisible chez l\'autre pair', async () => {
        const a = await open('alice')
        const b = await open('bob')
        const png = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'Mon image.png', { type: 'image/png' })
        await a.registerDocuments(['img1'])
        await a.files.upload('img1', png)
        a.directory.add({ id: 'img1', path: 'attachments/Mon image.png' })
        await harness.settle()
        expect(b.directory.getById('img1')?.path).toBe('attachments/Mon image.png')
        expect(await b.files.url('img1')).toMatch(/^(blob:|https?:|data:)/)
      })

      it('un pair arrive apres l\'envoi obtient aussi le fichier', async () => {
        const a = await open('alice')
        await a.files.upload('f2', new File(['tard'], 'tard.txt', { type: 'text/plain' }))
        await harness.settle()
        const b = await open('bob')
        await harness.settle()
        expect(await b.files.read('f2')).toBe('tard')
        expect(await b.files.url('f2')).not.toBe('')
      })

      it('un fichier inconnu est refuse, pas une URL vide', async () => {
        const a = await open('alice')
        await expect(a.files.url('inconnu')).rejects.toThrow()
        await expect(a.files.read('inconnu')).rejects.toThrow()
      })
    })

    describe('corbeille', () => {
      // Mettre a la corbeille n'est qu'un renommage sous `.trash/` dans le
      // repertoire : aucune hypothese sur un serveur.
      const clientOf = (session: IVaultSyncSession): VaultClient => {
        const fail = async (): Promise<never> => { throw new Error('stockage direct appele') }
        const storage: IVaultStorage = {
          readFile: fail, writeFile: fail, resolveFileUrl: () => '', listDocuments: fail, uploadAttachment: fail,
        }
        const store = new DocumentStore({ getDocumentContent: fail, writeDocumentContent: fail })
        return new VaultClient('v1', '', storage, store, session.directory, () => undefined, session)
      }

      it('un pair met a la corbeille, l\'autre la voit dans sa corbeille et peut restaurer', async () => {
        const a = clientOf(await open('alice'))
        const bSession = await open('bob')
        const b = clientOf(bSession)
        await a.createFile('Projet/note.md')
        await harness.settle()
        const id = b.resolveDocumentId('Projet/note.md')!
        expect(id).toBeDefined()

        await a.deleteFile(id)
        await harness.settle()
        expect(b.isTrashed(id)).toBe(true)
        expect(b.listTrash()).toEqual([{ documentId: id, path: '.trash/Projet/note.md', originalPath: 'Projet/note.md' }])
        expect(await b.list()).toEqual([])
        expect(b.documents).toEqual([])

        expect(await b.restoreFromTrash(id)).toBe('Projet/note.md')
        await harness.settle()
        expect(a.isTrashed(id)).toBe(false)
        expect(a.resolveDocumentId('Projet/note.md')).toBe(id)
        expect(a.listTrash()).toEqual([])
      })
    })

    describe('etat complet (copie d\'un vault)', () => {
      const textOf = async (session: IVaultSyncSession, docId: string): Promise<string> => {
        const crdt = session.openDocument(docId)
        await harness.settle()
        return (crdt as unknown as { rawDoc: { getText(n: string): { toString(): string } } }).rawDoc.getText('codemirror').toString()
      }

      it('l\'etat d\'un document se lit sans l\'ouvrir, et se fusionne ailleurs', async () => {
        const a = await open('alice')
        harness.insertText(a.openDocument('d1'), 0, 'bonjour')
        await harness.settle()
        const b = await open('bob')
        const state = await b.readDocumentState('d1')
        expect(state.length).toBeGreaterThan(2)
        const c = await open('carol')
        await c.mergeDocumentState('d2', state)
        await harness.settle()
        expect(await textOf(a, 'd2')).toBe('bonjour')
      })

      it('fusionner un etat atteint l\'editeur ouvert, et deux fois ne double rien', async () => {
        const a = await open('alice')
        const b = await open('bob')
        const crdtB = b.openDocument('d1')
        harness.insertText(a.openDocument('d1'), 0, 'texte')
        await harness.settle()
        const state = await a.readDocumentState('d1')
        await b.mergeDocumentState('d1', state)
        await b.mergeDocumentState('d1', state)
        await harness.settle()
        expect((crdtB as unknown as { rawDoc: { getText(n: string): { toString(): string } } }).rawDoc.getText('codemirror').toString()).toBe('texte')
        expect(await textOf(a, 'd1')).toBe('texte')
      })

      it('un fichier se lit en octets, avec son type', async () => {
        const a = await open('alice')
        await a.files.upload('f1', new Blob([new Uint8Array([0, 255, 7])], { type: 'image/png' }))
        await harness.settle()
        const b = await open('bob')
        const file = await b.files.readBytes('f1')
        expect([...file.bytes]).toEqual([0, 255, 7])
        expect(file.type).toBe('image/png')
        await expect(b.files.readBytes('inconnu')).rejects.toThrow()
      })

      it('une carte partagee dit quand son etat connu est arrive ; flush rend la main', async () => {
        const a = await open('alice')
        a.openSharedMap('review').set('c1', { text: 'ok' })
        await a.flush()
        await harness.settle()
        const b = await open('bob')
        const map = b.openSharedMap('review')
        if (map.loaded) await map.loaded
        else await harness.settle()
        expect(map.getAll()).toEqual([{ id: 'c1', value: { text: 'ok' } }])
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
