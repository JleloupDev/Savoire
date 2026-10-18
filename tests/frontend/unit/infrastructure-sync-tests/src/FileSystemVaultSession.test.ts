// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Vault sur disque : ce que le contrat commun ne dit pas. Persistance apres
// reouverture, modifications faites hors de l'application, renommages
// externes, ouverture d'un vault Obsidian, images, corbeille, format.
// Chaque test tourne sur un disque en memoire et sur un vrai dossier.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import {
  DocumentStore, InMemoryVaultFileSystem, VaultClient,
  type FileChange, type IVaultFileSystem, type IVaultStorage,
} from '@savoire/platform'
import {
  FileSystemVaultSession, FileSystemVaultSessionFactory, UnsupportedVaultFormatError, initializeVaultFolder,
  readVaultFolderMeta, type FileSystemVaultSessionOptions, type YjsCrdtAdapter,
} from '@savoire/infrastructure-sync'
import type { ICRDT } from '@savoire/plugin-api'
import { NodeVaultFileSystem } from './support/NodeVaultFileSystem'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const Y_ = Y as Record<string, any>

const OPTIONS: FileSystemVaultSessionOptions = { persistMs: 1, projectMs: 5, scanMs: 5 }

/** Enveloppe qui compte les ecritures, pour verifier qu'on ne reecrit rien pour rien. */
class CountingFs implements IVaultFileSystem {
  readonly writes: string[] = []
  readonly rootLabel: string
  readonly watch?: (cb: (changes: FileChange[]) => void) => () => void

  constructor(readonly inner: IVaultFileSystem) {
    this.rootLabel = inner.rootLabel
    if (inner.watch) this.watch = cb => inner.watch!(cb)
  }

  readText(p: string): Promise<string> { return this.inner.readText(p) }
  readBytes(p: string): Promise<Uint8Array> { return this.inner.readBytes(p) }
  writeText(p: string, c: string): Promise<void> { this.writes.push(p); return this.inner.writeText(p, c) }
  writeBytes(p: string, c: Uint8Array): Promise<void> { this.writes.push(p); return this.inner.writeBytes(p, c) }
  exists(p: string): Promise<boolean> { return this.inner.exists(p) }
  stat(p: string): ReturnType<IVaultFileSystem['stat']> { return this.inner.stat(p) }
  list(d: string, o?: { recursive?: boolean }): ReturnType<IVaultFileSystem['list']> { return this.inner.list(d, o) }
  mkdir(p: string): Promise<void> { this.writes.push(p); return this.inner.mkdir(p) }
  rename(f: string, t: string): Promise<void> { this.writes.push(f, t); return this.inner.rename(f, t) }
  remove(p: string): Promise<void> { this.writes.push(p); return this.inner.remove(p) }

  visibleWrites(): string[] {
    return this.writes.filter(p => !p.startsWith('.savoire'))
  }
}

const tempDirs: string[] = []
afterAll(() => { for (const d of tempDirs) rmSync(d, { recursive: true, force: true }) })

const disks: [string, () => IVaultFileSystem][] = [
  ['memoire', () => new InMemoryVaultFileSystem()],
  ['dossier reel', () => {
    const dir = mkdtempSync(join(tmpdir(), 'savoire-vault-'))
    tempDirs.push(dir)
    return new NodeVaultFileSystem(dir)
  }],
]

const textOf = (crdt: ICRDT): string =>
  ((crdt as YjsCrdtAdapter).rawDoc as { getText(n: string): { toString(): string } }).getText('codemirror').toString()

const ytextOf = (crdt: ICRDT): { insert(i: number, s: string): void; delete(i: number, n: number): void; toString(): string } =>
  ((crdt as YjsCrdtAdapter).rawDoc as { getText(n: string): never }).getText('codemirror')

/** Attend qu'une condition devienne vraie (evenements du disque asynchrones). */
async function until(cond: () => boolean | Promise<boolean>, timeoutMs = 3000): Promise<void> {
  const start = Date.now()
  while (!(await cond())) {
    if (Date.now() - start > timeoutMs) throw new Error('condition jamais remplie')
    await new Promise(r => setTimeout(r, 10))
  }
}

const wait = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

function clientOf(session: FileSystemVaultSession): VaultClient {
  const fail = async (): Promise<never> => { throw new Error('stockage direct appele') }
  const storage: IVaultStorage = { readFile: fail, writeFile: fail, resolveFileUrl: () => '', listDocuments: fail, uploadAttachment: fail }
  const store = new DocumentStore({ getDocumentContent: fail, writeDocumentContent: fail })
  return new VaultClient('v1', '', storage, store, session.directory, () => undefined, session)
}

for (const [diskName, makeDisk] of disks) {
  describe(`vault sur disque (${diskName})`, () => {
    const sessions: FileSystemVaultSession[] = []
    const open = async (fs: IVaultFileSystem, options: FileSystemVaultSessionOptions = OPTIONS): Promise<FileSystemVaultSession> => {
      const s = await FileSystemVaultSession.open(fs, { vaultId: 'v1', token: '', userId: 'alice', onChanged: () => {} }, options)
      sessions.push(s)
      return s
    }
    const close = async (s: FileSystemVaultSession): Promise<void> => {
      await s.dispose()
      sessions.splice(sessions.indexOf(s), 1)
    }
    afterEach(async () => { for (const s of sessions.splice(0)) await s.dispose() })

    describe('format du dossier', () => {
      it('un dossier vide devient un vault : seul .savoire/ est cree', async () => {
        const fs = makeDisk()
        const meta = await initializeVaultFolder(fs, { id: 'v1', name: 'Mon vault' })
        expect(meta).toMatchObject({ format: 1, id: 'v1', name: 'Mon vault' })
        expect(await readVaultFolderMeta(fs)).toEqual(meta)
        // Deja un vault : rien ne change.
        expect(await initializeVaultFolder(fs, { id: 'autre' })).toEqual(meta)
        expect((await fs.list('')).map(e => e.path)).toEqual(['.savoire'])
      })

      it('un format plus recent est refuse', async () => {
        const fs = makeDisk()
        await fs.writeText('.savoire/vault.json', JSON.stringify({ format: 99, id: 'v1', name: 'x' }))
        await expect(FileSystemVaultSession.open(fs, { vaultId: 'v1', token: '', userId: 'a', onChanged: () => {} }))
          .rejects.toBeInstanceOf(UnsupportedVaultFormatError)
      })

      it('la fabrique ouvre le dossier du vault demande', async () => {
        const fs = makeDisk()
        await fs.writeText('a.md', 'A')
        const factory = new FileSystemVaultSessionFactory(id => { expect(id).toBe('v1'); return fs }, OPTIONS)
        const s = await factory.open({ vaultId: 'v1', token: '', userId: 'a', onChanged: () => {} })
        sessions.push(s as FileSystemVaultSession)
        expect(s.directory.getAll().map(d => d.path)).toEqual(['a.md'])
        expect(s.locks).toBeUndefined()
        expect(s.sharing).toBeUndefined()
      })
    })

    describe('vault Obsidian existant', () => {
      it('s\'ouvre sans rien reecrire, cache et config Obsidian ignores', async () => {
        const inner = makeDisk()
        await inner.writeText('Accueil.md', '# Accueil\n\nVoir [[Projet/Plan]].\n')
        await inner.writeText('Projet/Plan.md', '- un\n- deux\n')
        await inner.writeBytes('Projet/Plan/schema.png', new Uint8Array([1, 2, 3]))
        await inner.writeText('.obsidian/app.json', '{}')
        await inner.writeText('.trash/Vieux.md', 'ancien')
        await inner.mkdir('Vide')
        const fs = new CountingFs(inner)
        const s = await open(fs)
        expect(s.directory.getAll().map(d => d.path).sort()).toEqual(['.trash/Vieux.md', 'Accueil.md', 'Projet/Plan.md', 'Projet/Plan/schema.png'])
        expect([...s.directory.getFolders()].sort()).toEqual(['Projet/', 'Projet/Plan/', 'Vide/'])

        // Lire, ouvrir une note, l'afficher : aucune ecriture hors de .savoire/.
        const id = clientOf(s).resolveDocumentId('Accueil.md')!
        expect(await s.readDocument(id, 'crdt')).toBe('# Accueil\n\nVoir [[Projet/Plan]].\n')
        const crdt = s.openDocument(id)
        await until(() => textOf(crdt) !== '')
        expect(textOf(crdt)).toBe('# Accueil\n\nVoir [[Projet/Plan]].\n')
        await s.flush()
        await wait(50)
        expect(fs.visibleWrites()).toEqual([])
        expect(await inner.readText('Accueil.md')).toBe('# Accueil\n\nVoir [[Projet/Plan]].\n')
        expect(await inner.exists('.savoire/vault.json')).toBe(true)
      })

      it('deux sessions qui decouvrent le meme vault donnent les memes ids et le meme texte', async () => {
        const fs = makeDisk()
        await fs.writeText('Note.md', 'bonjour')
        const a = await open(fs)
        const b = await open(fs)
        expect(a.directory.getAll()).toEqual(b.directory.getAll())
        const id = a.directory.getAll()[0].id
        const ca = a.openDocument(id)
        const cb = b.openDocument(id)
        await until(() => textOf(ca) === 'bonjour' && textOf(cb) === 'bonjour')
        ytextOf(ca).insert(7, ' !')
        await until(() => textOf(cb) === 'bonjour !')
        await wait(50)
        // Deux premiers etats identiques : Yjs ne les compte qu'une fois.
        expect(textOf(ca)).toBe('bonjour !')
      })
    })

    describe('persistance', () => {
      it('ids, texte, cartes et snapshots survivent a la reouverture', async () => {
        const fs = makeDisk()
        const s1 = await open(fs)
        const c1 = clientOf(s1)
        await c1.createFile('Dossier/Note.md')
        await c1.createFolder('Vide')
        const id = c1.resolveDocumentId('Dossier/Note.md')!
        ytextOf(s1.openDocument(id)).insert(0, 'texte persiste')
        s1.openSharedMap('review').set('c1', { ok: true })
        s1.directory.add({ id: 'snap', path: 'dessin.table' })
        await s1.flush()
        const snap = s1.openSnapshot('snap')
        await snap.load()
        await snap.write('{"v":1}')
        await close(s1)

        expect(await fs.readText('Dossier/Note.md')).toBe('texte persiste')
        expect(await fs.readText('dessin.table')).toBe('{"v":1}')

        const s2 = await open(fs)
        expect(s2.directory.getById(id)).toEqual({ id, path: 'Dossier/Note.md' })
        expect(s2.directory.getById('snap')).toEqual({ id: 'snap', path: 'dessin.table' })
        expect(s2.directory.getFolders()).toContain('Vide/')
        const crdt = s2.openDocument(id)
        await until(() => textOf(crdt) === 'texte persiste')
        const map = s2.openSharedMap('review')
        await map.loaded
        expect(map.getAll()).toEqual([{ id: 'c1', value: { ok: true } }])
        expect(await s2.openSnapshot('snap').load()).toBe('{"v":1}')
      })

      it('les mises a jour sont compactees a la fermeture', async () => {
        const fs = makeDisk()
        const s = await open(fs)
        const crdt = s.openDocument('d1')
        for (let i = 0; i < 5; i++) {
          ytextOf(crdt).insert(i, String(i))
          await s.flush()
        }
        expect((await fs.list('.savoire/crdt/d1')).length).toBeGreaterThan(1)
        s.closeDocument('d1')
        await s.flush()
        await until(async () => (await fs.list('.savoire/crdt/d1')).filter(e => e.path.endsWith('.state') || e.path.endsWith('.update')).length === 1)
        expect(await s.readDocument('d1', 'crdt')).toBe('01234')
      })
    })

    describe('projection du texte', () => {
      it('la frappe arrive dans le .md apres l\'anti-rebond, une seule ecriture', async () => {
        const inner = makeDisk()
        const fs = new CountingFs(inner)
        const s = await open(fs)
        s.directory.add({ id: 'n1', path: 'n.md' })
        const crdt = s.openDocument('n1')
        await s.flush()
        const before = fs.visibleWrites().length
        for (const ch of 'abc') ytextOf(crdt).insert(textOf(crdt).length, ch)
        await until(async () => (await inner.readText('n.md')) === 'abc')
        await wait(60)
        expect(fs.visibleWrites().length - before).toBe(1)
      })

      it('un document CRDT non textuel ne reecrit jamais son fichier visible', async () => {
        const inner = makeDisk()
        await inner.writeText('Dessin.excalidraw', '{"type":"excalidraw","elements":[]}')
        const fs = new CountingFs(inner)
        const s = await open(fs)
        const id = s.directory.getAll()[0].id
        s.openDocument(id)
        s.openTree(id).root.set('elements', 1)
        await s.flush()
        await wait(50)
        expect(fs.visibleWrites()).toEqual([])
        expect(await inner.readText('Dessin.excalidraw')).toBe('{"type":"excalidraw","elements":[]}')
        // Le plugin lit l'ancien contenu par le canal snapshot (migration).
        expect(await s.openSnapshot(id).load()).toBe('{"type":"excalidraw","elements":[]}')
      })
    })

    describe('modifications faites hors de l\'application', () => {
      it('un .md modifie ailleurs est relu par un diff minimal, sans boucle', async () => {
        const inner = makeDisk()
        await inner.writeText('n.md', 'ligne un\nligne deux\nligne trois\n')
        const fs = new CountingFs(inner)
        const s = await open(fs)
        const id = s.directory.getAll()[0].id
        const crdt = s.openDocument(id)
        await until(() => textOf(crdt) !== '')
        const doc = (crdt as YjsCrdtAdapter).rawDoc as ReturnType<typeof Y_.Doc>
        // Un curseur dans la derniere ligne : il doit survivre a la modification.
        const anchor = Y_.createRelativePositionFromTypeIndex(doc.getText('codemirror'), 'ligne un\nligne deux\nligne t'.length)
        const deltas: unknown[] = []
        s.openText(id).onChange((delta, origin) => deltas.push({ delta, origin }))

        await inner.writeText('n.md', 'ligne un\nligne 2\nligne trois\n')
        await until(() => textOf(crdt) === 'ligne un\nligne 2\nligne trois\n')
        expect(deltas).toEqual([{ delta: [{ retain: 15 }, { delete: 4 }, { insert: '2' }], origin: 'remote' }])
        const pos = Y_.createAbsolutePositionFromRelativePosition(anchor, doc)
        expect(pos.index).toBe('ligne un\nligne 2\nligne t'.length)

        // Pas de boucle : la session n'a pas reecrit le fichier.
        await s.flush()
        await wait(80)
        expect(fs.visibleWrites()).toEqual([])
        expect(await inner.readText('n.md')).toBe('ligne un\nligne 2\nligne trois\n')
      })

      it('une modification externe pendant la frappe fusionne les deux', async () => {
        const inner = makeDisk()
        await inner.writeText('n.md', 'debut\nfin\n')
        const s = await open(inner, { ...OPTIONS, projectMs: 200 })
        const id = s.directory.getAll()[0].id
        const crdt = s.openDocument(id)
        await until(() => textOf(crdt) !== '')
        ytextOf(crdt).insert(0, '>> ')
        await inner.writeText('n.md', 'debut\nmilieu\nfin\n')
        await until(() => textOf(crdt).includes('milieu'))
        expect(textOf(crdt)).toBe('>> debut\nmilieu\nfin\n')
        await until(async () => (await inner.readText('n.md')) === '>> debut\nmilieu\nfin\n')
      })

      it('un .md modifie pendant que l\'application est fermee est relu a l\'ouverture', async () => {
        const fs = makeDisk()
        const s1 = await open(fs)
        s1.directory.add({ id: 'n1', path: 'n.md' })
        ytextOf(s1.openDocument('n1')).insert(0, 'version app')
        await close(s1)
        expect(await fs.readText('n.md')).toBe('version app')
        await fs.writeText('n.md', 'version app, completee ailleurs')
        const s2 = await open(fs)
        const crdt = s2.openDocument('n1')
        await until(() => textOf(crdt) === 'version app, completee ailleurs')
      })

      it('une projection interrompue n\'efface pas le texte : le fichier est rattrape', async () => {
        const fs = makeDisk()
        const s1 = await open(fs, { ...OPTIONS, projectMs: 10_000 })
        s1.directory.add({ id: 'n1', path: 'n.md' })
        const crdt = s1.openDocument('n1')
        ytextOf(crdt).insert(0, 'premier')
        await s1.flush()
        expect(await fs.readText('n.md')).toBe('premier')
        ytextOf(crdt).insert(7, ' et second')
        // L'etat est ecrit, mais pas encore le fichier : on « coupe » ici.
        await (s1 as unknown as { replicas: Map<string, { log: { flush(): Promise<void> } }> }).replicas.get('n1')!.log.flush()
        const s2 = await open(fs)
        const c2 = s2.openDocument('n1')
        await until(() => textOf(c2) === 'premier et second')
        await until(async () => (await fs.readText('n.md')) === 'premier et second')
      })

      it('un snapshot modifie ailleurs arrive a la vue comme une ecriture externe', async () => {
        const fs = makeDisk()
        await fs.writeText('t.table', '{"v":1}')
        const s = await open(fs)
        const id = s.directory.getAll()[0].id
        const doc = s.openSnapshot(id)
        expect(await doc.load()).toBe('{"v":1}')
        const seen: [string, string][] = []
        doc.onRemoteWrite((c, from) => seen.push([c, from]))
        await doc.write('{"v":2}')
        await wait(40)
        expect(seen).toEqual([])
        await fs.writeText('t.table', '{"v":3}')
        await until(() => seen.length === 1)
        expect(seen).toEqual([['{"v":3}', 'external']])
      })

      it('sans watch, refresh() relit le disque', async () => {
        const fs = new InMemoryVaultFileSystem({ watch: false })
        const s = await open(fs)
        s.directory.add({ id: 'n1', path: 'n.md' })
        const crdt = s.openDocument('n1')
        await s.flush()
        await fs.writeText('n.md', 'ecrit ailleurs')
        await fs.writeText('nouveau.md', 'x')
        await wait(30)
        expect(textOf(crdt)).toBe('')
        await s.refresh()
        await until(() => textOf(crdt) === 'ecrit ailleurs')
        expect(s.directory.getAll().map(d => d.path).sort()).toEqual(['n.md', 'nouveau.md'])
      })
    })

    describe('renommages', () => {
      it('un renommage fait ailleurs garde l\'id (meme taille, meme date)', async () => {
        const fs = makeDisk()
        await fs.writeText('Ancien.md', 'contenu')
        const s = await open(fs)
        const id = s.directory.getAll()[0].id
        await fs.rename('Ancien.md', 'Rangé/Nouveau.md')
        await until(() => s.directory.getById(id)?.path === 'Rangé/Nouveau.md')
        expect(s.directory.getAll()).toEqual([{ id, path: 'Rangé/Nouveau.md' }])
      })

      it('un renommage fait pendant la fermeture garde l\'id et l\'etat', async () => {
        const fs = makeDisk()
        const s1 = await open(fs)
        s1.directory.add({ id: 'n1', path: 'a.md' })
        ytextOf(s1.openDocument('n1')).insert(0, 'garde son histoire')
        await close(s1)
        await fs.rename('a.md', 'b.md')
        const s2 = await open(fs)
        expect(s2.directory.getAll()).toEqual([{ id: 'n1', path: 'b.md' }])
        const crdt = s2.openDocument('n1')
        await until(() => textOf(crdt) === 'garde son histoire')
      })

      it('un fichier copie puis efface ailleurs, contenu change : nouveau document', async () => {
        const fs = makeDisk()
        await fs.writeText('a.md', 'un')
        const s = await open(fs)
        const id = s.directory.getAll()[0].id
        await fs.remove('a.md')
        await fs.writeText('b.md', 'autre chose')
        await until(() => s.directory.getAll().some(d => d.path === 'b.md'))
        expect(s.directory.getById(id)).toBeUndefined()
      })

      it('un renommage dans l\'application deplace le fichier et n\'ecrase jamais', async () => {
        const fs = makeDisk()
        await fs.writeText('a.md', 'A')
        await fs.writeText('b.md', 'B')
        const s = await open(fs)
        const c = clientOf(s)
        const idA = c.resolveDocumentId('a.md')!
        await c.renameDocument(idA, 'Dossier/c.md')
        await s.flush()
        expect(await fs.exists('a.md')).toBe(false)
        expect(await fs.readText('Dossier/c.md')).toBe('A')
        await c.renameDocument(idA, 'b.md')
        await s.flush()
        expect(await fs.readText('b.md')).toBe('B')
        expect(await fs.readText('b 1.md')).toBe('A')
        expect(s.directory.getById(idA)?.path).toBe('b 1.md')
        // Le dossier vide par le depart de son seul fichier quitte le disque.
        expect(await fs.exists('Dossier')).toBe(false)
      })
    })

    describe('images', () => {
      it('les octets vivent au chemin lisible de l\'image, l\'URL s\'affiche', async () => {
        const fs = makeDisk()
        const s = await open(fs)
        const c = clientOf(s)
        await c.createFile('Projet/Note.md')
        const png = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'Capture.png', { type: 'image/png' })
        const path = await c.uploadAttachment(png, { notePath: 'Projet/Note.md' })
        await s.flush()
        expect(path).toBe('Projet/Note/Capture.png')
        expect([...await fs.readBytes('Projet/Note/Capture.png')]).toEqual([0x89, 0x50, 0x4e, 0x47])
        expect((await fs.list('.savoire/detached').catch(() => [])).length).toBe(0)
        expect(await c.resolveAttachmentUrl('Capture.png')).toMatch(/^blob:/)
        const id = c.resolveDocumentId(path)!
        expect((await s.files.readBytes(id)).type).toBe('image/png')
      })

      it('une image deja dans le dossier (Obsidian) s\'affiche par son nom', async () => {
        const fs = makeDisk()
        await fs.writeBytes('attachments/photo.jpg', new Uint8Array([9, 9]))
        const s = await open(fs)
        const c = clientOf(s)
        expect(await c.resolveAttachmentUrl('photo.jpg')).toMatch(/^blob:/)
        const id = c.resolveDocumentId('attachments/photo.jpg')!
        expect(await s.files.readBytes(id)).toEqual({ bytes: new Uint8Array([9, 9]), type: 'image/jpeg' })
      })
    })

    describe('corbeille', () => {
      it('supprimer range dans .trash/, restaurer ramene, effacer efface pour de bon', async () => {
        const fs = makeDisk()
        const s = await open(fs)
        const c = clientOf(s)
        await c.createFile('Projet/note.md')
        const id = c.resolveDocumentId('Projet/note.md')!
        ytextOf(s.openDocument(id)).insert(0, 'a garder')
        await s.flush()
        s.closeDocument(id)

        await c.deleteFile(id)
        await s.flush()
        expect(await fs.readText('.trash/Projet/note.md')).toBe('a garder')
        expect(await fs.exists('Projet')).toBe(false)

        expect(await c.restoreFromTrash(id)).toBe('Projet/note.md')
        await s.flush()
        expect(await fs.readText('Projet/note.md')).toBe('a garder')
        expect(await fs.exists('.trash/Projet')).toBe(false)

        await c.deleteFile(id)
        await c.deleteFilePermanently(id)
        await s.flush()
        await until(async () => !(await fs.exists('.trash/Projet/note.md')) && !(await fs.exists(`.savoire/crdt/${id}`)))
        expect(s.directory.getById(id)).toBeUndefined()
      })

      it('un dossier cree expres reste quand son dernier fichier part', async () => {
        const fs = makeDisk()
        const s = await open(fs)
        const c = clientOf(s)
        await c.createFolder('Garde')
        await c.createFile('Garde/n.md')
        await c.deleteFile(c.resolveDocumentId('Garde/n.md')!)
        await s.flush()
        expect(await fs.exists('Garde')).toBe(true)
        expect(await c.list()).toEqual(['Garde/'])
      })
    })

    describe('vault disparu', () => {
      it('le dossier .savoire/ efface est signale une fois', async () => {
        const fs = makeDisk()
        let gone = 0
        const s = await FileSystemVaultSession.open(fs, { vaultId: 'v1', token: '', userId: 'a', onChanged: () => {}, onVaultGone: () => gone++ }, OPTIONS)
        sessions.push(s)
        await fs.remove('.savoire')
        await until(() => gone === 1)
        await wait(30)
        expect(gone).toBe(1)
      })
    })
  })
}
