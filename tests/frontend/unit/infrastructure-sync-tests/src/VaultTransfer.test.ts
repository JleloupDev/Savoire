// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Copie d'un vault entre deux sessions (transferVault), sans savoir laquelle
// est un serveur ou un disque : ici deux sessions du profil local, chacune sur
// son bus (deux vaults qui ne se voient pas).
import { describe, it, expect, afterEach } from 'vitest'
import * as Y from 'yjs'
import { InProcessPeerBus, LocalPeerVaultSessionFactory, type YjsCrdtAdapter } from '@savoire/infrastructure-sync'
import { transferVault, type IVaultSyncSession, type VaultTransferProgress } from '@savoire/application'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const Y_ = Y as Record<string, any>

const SETTLE_MS = 5
const settle = (): Promise<void> => new Promise(r => setTimeout(r, SETTLE_MS * 4))

const sessions: IVaultSyncSession[] = []
afterEach(async () => {
  for (const s of sessions.splice(0)) await s.dispose()
})

async function openVault(vaultId: string): Promise<IVaultSyncSession> {
  const factory = new LocalPeerVaultSessionFactory(new InProcessPeerBus(), { settleMs: SETTLE_MS })
  const s = await factory.open({ vaultId, token: '', userId: 'alice', onChanged: () => {} })
  sessions.push(s)
  return s
}

/** Les plans et pages sont des CRDT (types declares 'crdt' par leurs plugins). */
const syncKindOf = (path: string): 'crdt' | 'snapshot' =>
  /\.(md|page|outline|chat)$/.test(path) ? 'crdt' : 'snapshot'

function writeText(session: IVaultSyncSession, docId: string, text: string): void {
  const crdt = session.openDocument(docId) as YjsCrdtAdapter
  const ytext = (crdt.rawDoc as { getText(n: string): { insert(i: number, t: string): void } }).getText('codemirror')
  ytext.insert(0, text)
}

async function writeSnapshot(session: IVaultSyncSession, docId: string, content: string): Promise<void> {
  const doc = session.openSnapshot(docId)
  await doc.load()
  await doc.write(content)
  session.closeSnapshot(docId)
}

/** Etat lu dans un Y.Doc neuf : le texte et l'arbre du document. */
async function readBack(session: IVaultSyncSession, docId: string): Promise<{ text: string; tree: unknown }> {
  const doc = new Y_.Doc()
  Y_.applyUpdate(doc, await session.readDocumentState(docId))
  return { text: doc.getText('codemirror').toString(), tree: doc.getMap('tree').toJSON() }
}

/** Un vault complet : notes, dossiers vides, page en arbre, plan, dessin, image, corbeille, cartes. */
async function seedVault(s: IVaultSyncSession): Promise<void> {
  const d = s.directory
  d.add({ id: 'n1', path: 'Projet.md' })
  writeText(s, 'n1', '# Projet\n\nVoir ![[schema.png]]')
  d.add({ id: 'n2', path: 'Projet/Sous-note.md' })
  writeText(s, 'n2', 'sous-note')
  d.add({ id: 'img', path: 'Projet/schema.png' })
  await s.files.upload('img', new Blob([new Uint8Array([137, 80, 78, 71, 1, 2, 3])], { type: 'image/png' }))
  d.addFolder('Vide/')
  d.addFolder('Projet/Archives/')
  d.add({ id: 'pg', path: 'Accueil.page' })
  s.openDocument('pg')
  s.openTree('pg').root.set('title', 'Bienvenue')
  d.add({ id: 'pl', path: 'Plan.outline' })
  s.openDocument('pl')
  s.openTree('pl').root.set('items', { kind: 'list', items: ['un', 'deux'] } as never)
  d.add({ id: 'ex', path: 'Dessin.excalidraw' })
  await writeSnapshot(s, 'ex', '{"elements":[{"id":"a"}]}')
  d.add({ id: 'tr', path: '.trash/Ancienne.md' })
  writeText(s, 'tr', 'jetee')
  d.add({ id: 'ch', path: 'Equipe.chat' })
  s.openDocument('ch')
  s.openVaultSettings('plugins').set('plugin-graph', { enabled: true })
  s.openSharedMap('review').set('c1', { id: 'c1', docId: 'n1', kind: 'comment', text: 'A revoir' })
  s.openSharedMap('doc/ch/messages').set('m1', { text: 'salut' })
  await settle()
}

describe('transferVault — copie entre deux sessions', () => {
  it('copie tout le vault en gardant les identifiants', async () => {
    const source = await openVault('src')
    const target = await openVault('dst')
    await seedVault(source)

    const steps: VaultTransferProgress[] = []
    const report = await transferVault(source, target, { syncKindOf, onProgress: p => steps.push(p) })

    expect(report.errors).toEqual([])
    expect(report.cancelled).toBe(false)
    expect(report.copied).toBe(8)
    expect(report.folders).toBe(2)
    expect(report.maps).toBe(3)
    expect(report.renamedIds).toEqual({})

    const byId = (id: string) => target.directory.getById(id)?.path
    expect(byId('n1')).toBe('Projet.md')
    expect(byId('n2')).toBe('Projet/Sous-note.md')
    expect(byId('img')).toBe('Projet/schema.png')
    expect(byId('tr')).toBe('.trash/Ancienne.md')
    expect([...target.directory.getFolders()].sort()).toEqual(['Projet/Archives/', 'Vide/'])

    expect((await readBack(target, 'n1')).text).toBe('# Projet\n\nVoir ![[schema.png]]')
    expect((await readBack(target, 'tr')).text).toBe('jetee')
    expect((await readBack(target, 'pg')).tree).toEqual({ title: 'Bienvenue' })
    expect(await target.readDocument('ex', 'snapshot')).toBe('{"elements":[{"id":"a"}]}')
    const file = await target.files.readBytes('img')
    expect([...file.bytes]).toEqual([137, 80, 78, 71, 1, 2, 3])
    expect(file.type).toBe('image/png')

    const settings = target.openVaultSettings('plugins')
    await settings.loaded
    expect(settings.getAll()).toEqual([{ id: 'plugin-graph', value: { enabled: true } }])
    expect(target.openSharedMap('review').getAll()[0].value).toMatchObject({ docId: 'n1', text: 'A revoir' })
    expect(target.openSharedMap('doc/ch/messages').getAll()).toEqual([{ id: 'm1', value: { text: 'salut' } }])

    // Progression : du debut a la fin, sans retour en arriere, octets comptes.
    expect(steps[0].phase).toBe('preparing')
    expect(steps.at(-1)).toMatchObject({ phase: 'done' })
    expect(steps.at(-1)!.done).toBe(steps.at(-1)!.total)
    expect(steps.at(-1)!.bytes).toBeGreaterThan(0)
    expect(report.bytes).toBe(steps.at(-1)!.bytes)
  })

  it('relancer ne duplique rien et ne change pas le contenu', async () => {
    const source = await openVault('src')
    const target = await openVault('dst')
    await seedVault(source)
    await transferVault(source, target, { syncKindOf })
    const before = target.directory.getAll().map(d => `${d.id}:${d.path}`).sort()

    const again = await transferVault(source, target, { syncKindOf })

    expect(again.errors).toEqual([])
    expect(target.directory.getAll().map(d => `${d.id}:${d.path}`).sort()).toEqual(before)
    expect(again.folders).toBe(0)
    // Dessin, image et discussion vide : deja la a l'identique.
    expect(again.skipped).toBe(3)
    expect((await readBack(target, 'n1')).text).toBe('# Projet\n\nVoir ![[schema.png]]')
    expect(target.openSharedMap('review').getAll()).toHaveLength(1)
  })

  it('complete la cible sans ecraser ce qui y a change depuis', async () => {
    const source = await openVault('src')
    const target = await openVault('dst')
    await seedVault(source)
    await transferVault(source, target, { syncKindOf })
    writeText(target, 'n2', 'ajout cible : ')
    writeText(source, 'n2', 'ajout source : ')
    await settle()

    await transferVault(source, target, { syncKindOf })

    const text = (await readBack(target, 'n2')).text
    expect(text).toContain('ajout cible : ')
    expect(text).toContain('ajout source : ')
    expect(text).toContain('sous-note')
  })

  it("une erreur sur un document n'arrete pas les autres", async () => {
    const source = await openVault('src')
    const target = await openVault('dst')
    await seedVault(source)
    const broken: IVaultSyncSession = Object.create(source)
    broken.readDocumentState = async (id: string) => {
      if (id === 'n2') throw new Error('lecture impossible')
      return source.readDocumentState(id)
    }

    const report = await transferVault(broken, target, { syncKindOf })

    expect(report.errors).toEqual([{ path: 'Projet/Sous-note.md', message: 'lecture impossible' }])
    expect(report.copied).toBe(7)
    // Pas de document vide : il n'apparait pas dans la cible.
    expect(target.directory.getById('n2')).toBeUndefined()
    expect(target.directory.getById('n1')).toBeDefined()

    // Relancer, une fois la panne passee, complete la copie.
    const retry = await transferVault(source, target, { syncKindOf })
    expect(retry.errors).toEqual([])
    expect((await readBack(target, 'n2')).text).toBe('sous-note')
  })

  it('un identifiant refuse par la cible prend un identifiant neuf, et la revision le suit', async () => {
    const source = await openVault('src')
    const target = await openVault('dst')
    await seedVault(source)
    // La cible refuse n1 (deja inscrit dans un autre vault, comme le serveur).
    const register = target.registerDocuments.bind(target)
    target.registerDocuments = async (ids: string[]) => {
      if (ids.includes('n1')) throw new Error('documents deja inscrits dans un autre vault : n1')
      return register(ids)
    }

    const report = await transferVault(source, target, { syncKindOf })

    expect(report.errors).toEqual([])
    const newId = report.renamedIds.n1
    expect(newId).toBeDefined()
    expect(newId).not.toBe('n1')
    expect(target.directory.getById(newId)?.path).toBe('Projet.md')
    expect(target.directory.getById('n1')).toBeUndefined()
    expect(target.directory.getById('n2')?.path).toBe('Projet/Sous-note.md')
    expect((await readBack(target, newId)).text).toContain('# Projet')
    expect(target.openSharedMap('review').getAll()[0].value).toMatchObject({ docId: newId })

    // Relancer reprend le meme document (meme chemin), sans doublon.
    const again = await transferVault(source, target, { syncKindOf })
    expect(again.renamedIds.n1).toBe(newId)
    expect(target.directory.getAll().filter(d => d.path === 'Projet.md')).toHaveLength(1)
  })

  it('un autre document au meme chemin dans la cible : le nouveau prend un suffixe', async () => {
    const source = await openVault('src')
    const target = await openVault('dst')
    await seedVault(source)
    target.directory.add({ id: 'autre', path: 'Projet.md' })

    const report = await transferVault(source, target, { syncKindOf })

    expect(report.renamedPaths).toEqual({ 'Projet.md': 'Projet 1.md' })
    expect(target.directory.getById('n1')?.path).toBe('Projet 1.md')
    expect(target.directory.getById('autre')?.path).toBe('Projet.md')
  })

  it("l'annulation arrete la copie ; relancer la termine", async () => {
    const source = await openVault('src')
    const target = await openVault('dst')
    await seedVault(source)
    const controller = new AbortController()

    const report = await transferVault(source, target, {
      syncKindOf,
      concurrency: 1,
      signal: controller.signal,
      onProgress: p => { if (p.phase === 'documents' && p.current) controller.abort() },
    })

    expect(report.cancelled).toBe(true)
    expect(target.directory.getAll().length).toBeLessThan(source.directory.getAll().length)
    const done = await transferVault(source, target, { syncKindOf })
    expect(done.cancelled).toBe(false)
    expect(target.directory.getAll()).toHaveLength(source.directory.getAll().length)
  })
})
