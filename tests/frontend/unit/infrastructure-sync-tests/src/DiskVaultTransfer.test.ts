// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Telechargement et envoi d'un vault avec la vraie session sur disque
// (FileSystemVaultSession) sur un dossier en memoire : ce que la personne
// retrouve dans le dossier (notes lisibles, images, dossiers vides,
// corbeille), et l'aller-retour qui garde les memes documents.
import { describe, it, expect, afterEach } from 'vitest'
import { FileSystemVaultSession, InProcessPeerBus, LocalPeerVaultSessionFactory, type YjsCrdtAdapter } from '@savoire/infrastructure-sync'
import { InMemoryVaultFileSystem } from '@savoire/platform'
import { transferVault, VaultTransferService, type IVaultSyncSession, type VaultSyncSessionFactoryParams } from '@savoire/application'

const SETTLE_MS = 5
const settle = (ms = SETTLE_MS * 4): Promise<void> => new Promise(r => setTimeout(r, ms))
const sessions: IVaultSyncSession[] = []
afterEach(async () => { for (const s of sessions.splice(0)) await s.dispose() })

const params = (vaultId: string): VaultSyncSessionFactoryParams => ({ vaultId, token: '', userId: 'alice', onChanged: () => {} })
const diskOptions = { persistMs: 0, projectMs: 0, scanMs: 0 }
const openDisk = async (fs: InMemoryVaultFileSystem, vaultId: string): Promise<IVaultSyncSession> => {
  const s = await FileSystemVaultSession.open(fs, params(vaultId), diskOptions)
  sessions.push(s)
  return s
}
async function openLocal(vaultId: string, bus = new InProcessPeerBus()): Promise<IVaultSyncSession> {
  const s = await new LocalPeerVaultSessionFactory(bus, { settleMs: SETTLE_MS }).open(params(vaultId))
  sessions.push(s)
  return s
}
const syncKindOf = (path: string): 'crdt' | 'snapshot' => (/\.(md|page|outline)$/.test(path) ? 'crdt' : 'snapshot')

function writeText(session: IVaultSyncSession, docId: string, text: string): void {
  const crdt = session.openDocument(docId) as YjsCrdtAdapter
  ;(crdt.rawDoc as { getText(n: string): { insert(i: number, t: string): void } }).getText('codemirror').insert(0, text)
}

async function seed(s: IVaultSyncSession): Promise<void> {
  s.directory.add({ id: 'n1', path: 'Projet.md' })
  writeText(s, 'n1', '# Projet\n\n![[schema.png]]\n')
  s.directory.add({ id: 'n2', path: 'Projet/Detail.md' })
  writeText(s, 'n2', 'detail')
  s.directory.add({ id: 'img', path: 'Projet/schema.png' })
  await s.files.upload('img', new Blob([new Uint8Array([137, 80, 78, 71, 9])], { type: 'image/png' }))
  s.directory.addFolder('Vide/')
  s.directory.add({ id: 'pg', path: 'Accueil.page' })
  s.openDocument('pg')
  s.openTree('pg').root.set('title', 'Bienvenue')
  s.directory.add({ id: 'ex', path: 'Dessin.excalidraw' })
  const ex = s.openSnapshot('ex')
  await ex.load()
  await ex.write('{"elements":[]}')
  s.closeSnapshot('ex')
  s.directory.add({ id: 'tr', path: '.trash/Vieux.md' })
  writeText(s, 'tr', 'jete')
  s.openVaultSettings('plugins').set('plugin-graph', { enabled: true })
  await settle()
}

describe('transfert avec la session sur disque', () => {
  it('telecharge dans un dossier vide : notes lisibles, image, dossier vide, corbeille, ids gardes', async () => {
    const remote = await openLocal('v1')
    await seed(remote)
    const fs = new InMemoryVaultFileSystem({ rootLabel: 'Copie' })
    const disk = await openDisk(fs, 'v1')

    const report = await transferVault(remote, disk, { syncKindOf })
    expect(report.errors).toEqual([])
    await disk.flush()
    await disk.dispose()
    sessions.splice(sessions.indexOf(disk), 1)

    // Ce que la personne voit dans le dossier.
    expect(await fs.readText('Projet.md')).toBe('# Projet\n\n![[schema.png]]\n')
    expect(await fs.readText('Projet/Detail.md')).toBe('detail')
    expect([...(await fs.readBytes('Projet/schema.png'))]).toEqual([137, 80, 78, 71, 9])
    expect(await fs.readText('Dessin.excalidraw')).toBe('{"elements":[]}')
    expect(await fs.readText('.trash/Vieux.md')).toBe('jete')
    expect((await fs.stat('Vide'))?.kind).toBe('directory')

    // Rouvert plus tard : memes documents, meme etat.
    const again = await openDisk(fs, 'v1')
    expect(again.directory.getById('n1')?.path).toBe('Projet.md')
    expect(again.directory.getById('pg')?.path).toBe('Accueil.page')
    expect(await again.readDocument('n1', 'crdt')).toBe('# Projet\n\n![[schema.png]]\n')
    const settings = again.openVaultSettings('plugins')
    await settings.loaded
    expect(settings.getAll()).toEqual([{ id: 'plugin-graph', value: { enabled: true } }])

    // Relancer le telechargement dans le meme dossier ne duplique rien.
    const rerun = await transferVault(remote, again, { syncKindOf })
    expect(rerun.errors).toEqual([])
    expect(again.directory.getAll()).toHaveLength(remote.directory.getAll().length)
    expect(await fs.readText('Projet.md')).toBe('# Projet\n\n![[schema.png]]\n')
  })

  it('envoie un dossier du poste (notes ecrites par un autre outil) vers un vault vide', async () => {
    const fs = new InMemoryVaultFileSystem({ rootLabel: 'Obsidian' })
    await fs.writeText('Idees.md', '- une\n- deux\n')
    await fs.writeText('Sous/Note.md', 'note')
    await fs.writeBytes('Sous/photo.png', new Uint8Array([1, 2, 3]))
    await fs.mkdir('Vide')
    const disk = await openDisk(fs, 'local')
    await settle(30)
    const target = await openLocal('v2')

    const report = await transferVault(disk, target, { syncKindOf })

    expect(report.errors).toEqual([])
    const paths = target.directory.getAll().map(d => d.path).sort()
    expect(paths).toEqual(['Idees.md', 'Sous/Note.md', 'Sous/photo.png'])
    expect(target.directory.getFolders()).toContain('Vide/')
    const idees = target.directory.getAll().find(d => d.path === 'Idees.md')!
    expect(idees.id).toBe(disk.directory.getAll().find(d => d.path === 'Idees.md')!.id)
    expect(await target.readDocument(idees.id, 'crdt')).toBe('- une\n- deux\n')
    const photo = target.directory.getAll().find(d => d.path === 'Sous/photo.png')!
    expect([...(await target.files.readBytes(photo.id)).bytes]).toEqual([1, 2, 3])
  })

  it('le service telecharge puis exporte le dossier en memoire', async () => {
    const remote = await openLocal('v1')
    await seed(remote)
    const service = new VaultTransferService({
      remote: async () => ({ sessions: { open: async () => remote }, vaults: { create: async () => { throw new Error('inutile') } }, auth: { userId: 'alice', token: '' } }),
      activeSession: () => remote,
      openDiskSession: (fs, p) => FileSystemVaultSession.open(fs, p, diskOptions),
      transferOptions: () => ({ syncKindOf }),
    })
    const fs = new InMemoryVaultFileSystem({ rootLabel: 'Export' })

    const result = await service.downloadVault('v1', fs).result

    expect(result.errors).toEqual([])
    const files = (await fs.list('', { recursive: true })).filter(e => e.kind === 'file').map(e => e.path)
    expect(files).toEqual(expect.arrayContaining(['Projet.md', 'Projet/schema.png', '.savoire/vault.json']))
  })
})
