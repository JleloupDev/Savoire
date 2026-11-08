// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// La nature d'un document (crdt ou snapshot) est enregistree avec lui :
// elle voyage entre pairs, suit les renommages, se garde sur le disque.
import { describe, it, expect, afterEach } from 'vitest'
import { FileSystemVaultSession, YMapVaultDirectory } from '@savoire/infrastructure-sync'
import { DocumentStore, InMemoryVaultFileSystem, VaultClient, type IVaultStorage } from '@savoire/platform'

describe('nature d un document (repertoire en memoire)', () => {
  it('se lit, suit un renommage, et passe a un autre pair', () => {
    const a = new YMapVaultDirectory()
    const b = new YMapVaultDirectory()
    a.onLocalUpdate(u => b.applyUpdate(u))
    a.add({ id: 'w', path: 'Essai.wtf', kind: 'crdt' })
    a.add({ id: 'n', path: 'Note.md' })
    expect(a.getById('w')).toEqual({ id: 'w', path: 'Essai.wtf', kind: 'crdt' })
    expect(a.getById('n')).toEqual({ id: 'n', path: 'Note.md' })
    a.rename('w', 'Dossier/Essai.wtf')
    expect(b.getById('w')).toEqual({ id: 'w', path: 'Dossier/Essai.wtf', kind: 'crdt' })
    a.add({ id: 'x', path: 'Dessin.excalidraw' })
    a.setKind('x', 'snapshot')
    expect(b.getById('x')?.kind).toBe('snapshot')
    // Inconnu : rien ne se passe.
    a.setKind('absent', 'crdt')
    expect(a.getById('absent')).toBeUndefined()
  })
})

describe('nature d un document (vault sur disque)', () => {
  const sessions: FileSystemVaultSession[] = []
  afterEach(async () => { for (const s of sessions.splice(0)) await s.dispose() })
  const open = async (fs: InMemoryVaultFileSystem) => {
    const s = await FileSystemVaultSession.open(fs, { vaultId: 'v1', token: '', userId: 'a', onChanged: () => {} }, { persistMs: 5, projectMs: 5, scanMs: 5 })
    sessions.push(s)
    return s
  }

  it('se garde dans .savoire/documents.json et revient a la reouverture', async () => {
    const fs = new InMemoryVaultFileSystem({ watch: false })
    await fs.writeText('Essai.wtf', 'texte')
    const s1 = await open(fs)
    const id = s1.directory.getAll().find(d => d.path === 'Essai.wtf')!.id
    s1.directory.setKind!(id, 'crdt')
    await s1.flush()
    await s1.dispose(); sessions.splice(0)
    const file = JSON.parse(await fs.readText('.savoire/documents.json'))
    expect(file.documents[id].kind).toBe('crdt')
    const s2 = await open(fs)
    expect(s2.directory.getById(id)?.kind).toBe('crdt')
  })

  it('un document cree par l application recoit la nature de son type', async () => {
    const fs = new InMemoryVaultFileSystem({ watch: false })
    const s = await open(fs)
    const fail = async (): Promise<never> => { throw new Error('stockage direct appele') }
    const storage: IVaultStorage = { readFile: fail, writeFile: fail, resolveFileUrl: () => '', listDocuments: fail, uploadAttachment: fail }
    const client = new VaultClient('v1', '', storage, new DocumentStore({ getDocumentContent: fail, writeDocumentContent: fail }),
      s.directory, () => undefined, s, path => (path.endsWith('.wtf') || path.endsWith('.md') ? 'crdt' : 'snapshot'))
    await client.createFile('Essai.wtf')
    await client.createFile('Carte.mm')
    await client.createFile('Note')
    const byPath = new Map(s.directory.getAll().map(d => [d.path, d]))
    expect(byPath.get('Essai.wtf')?.kind).toBe('crdt')
    expect(byPath.get('Carte.mm')?.kind).toBeUndefined()
    expect(byPath.get('Note.md')?.kind).toBeUndefined()
    // Lu sans le plugin (type inconnu => snapshot par defaut) : la nature enregistree gagne.
    const bare = new VaultClient('v1', '', storage, new DocumentStore({ getDocumentContent: fail, writeDocumentContent: fail }), s.directory, () => undefined, s)
    expect(bare.kindOf(byPath.get('Essai.wtf')!)).toBe('crdt')
    await s.flush()
    const file = JSON.parse(await fs.readText('.savoire/documents.json'))
    expect(file.documents[byPath.get('Essai.wtf')!.id].kind).toBe('crdt')
  })
})
