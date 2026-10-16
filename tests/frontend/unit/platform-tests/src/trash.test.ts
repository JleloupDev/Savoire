// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Corbeille : chemins, collisions, restauration, filtrage. Supprimer met a
// la corbeille (`.trash/`), comme Obsidian.
import { describe, it, expect, vi } from 'vitest'
import {
  DocumentStore, VaultClient, TRASH_DIR, isTrashPath, trashPathFor, originalPathOf, restorePathFor,
  type IVaultStorage,
} from '@savoire/platform'
import { InMemoryVaultDirectory } from './InMemoryVaultDirectory'

const stubStorage: IVaultStorage = {
  readFile: vi.fn(async () => ''),
  writeFile: vi.fn(async () => {}),
  resolveFileUrl: (_v, path) => `/attachments/${path}`,
  listDocuments: vi.fn(async () => []),
  uploadAttachment: vi.fn(async (_v, file) => ({ fileName: file.name, storagePath: 'sp' })),
}

function makeClient(docs: { id: string; path: string }[] = []) {
  const directory = new InMemoryVaultDirectory()
  for (const d of docs) directory.add(d)
  const store = new DocumentStore({ getDocumentContent: vi.fn(async () => ''), writeDocumentContent: vi.fn(async () => {}) })
  const client = new VaultClient('v', 't', stubStorage, store, directory, () => undefined)
  return { client, directory }
}

describe('chemins de la corbeille', () => {
  it('garde le chemin d\'origine sous .trash/', () => {
    expect(TRASH_DIR).toBe('.trash/')
    expect(trashPathFor('Projet/Note.md', () => false)).toBe('.trash/Projet/Note.md')
    expect(isTrashPath('.trash/Projet/Note.md')).toBe(true)
    expect(isTrashPath('Projet/.trash/Note.md')).toBe(false)
    expect(originalPathOf('.trash/Projet/Note.md')).toBe('Projet/Note.md')
  })

  it('collision : suffixe avant l\'extension', () => {
    const taken = new Set(['.trash/Note.md', '.trash/Note 1.md'])
    expect(trashPathFor('Note.md', p => taken.has(p))).toBe('.trash/Note 2.md')
    // Un point dans un dossier n'est pas une extension.
    expect(trashPathFor('v1.2/Lisez', p => p === '.trash/v1.2/Lisez')).toBe('.trash/v1.2/Lisez 1')
  })

  it('restauration : chemin d\'origine, suffixe s\'il a ete repris', () => {
    expect(restorePathFor('.trash/A/x.md', () => false)).toBe('A/x.md')
    expect(restorePathFor('.trash/A/x.md', p => p === 'A/x.md')).toBe('A/x 1.md')
  })
})

describe('VaultClient et la corbeille', () => {
  it('deleteFile met a la corbeille : renommage, rien n\'est efface', async () => {
    const { client, directory } = makeClient([{ id: 'n1', path: 'A/x.md' }])
    await client.deleteFile('n1')
    expect(directory.getById('n1')?.path).toBe('.trash/A/x.md')
    expect(client.isTrashed('n1')).toBe(true)
    expect(client.listTrash()).toEqual([{ documentId: 'n1', path: '.trash/A/x.md', originalPath: 'A/x.md' }])
    // Deja dans la corbeille : deleteFile ne la deplace pas.
    await client.deleteFile('n1')
    expect(directory.getById('n1')?.path).toBe('.trash/A/x.md')
  })

  it('deux documents du meme chemin : le second prend un suffixe', async () => {
    const { client } = makeClient([{ id: 'a', path: 'x.md' }])
    await client.deleteFile('a')
    await client.createFile('x.md')
    const b = client.resolveDocumentId('x.md')!
    await client.deleteFile(b)
    expect(client.listTrash().map(e => e.path).sort()).toEqual(['.trash/x 1.md', '.trash/x.md'])
  })

  it('restaurer remet le document a sa place, ou a cote si elle est prise', async () => {
    const { client, directory } = makeClient([{ id: 'n1', path: 'A/x.md' }])
    await client.deleteFile('n1')
    expect(await client.restoreFromTrash('n1')).toBe('A/x.md')
    expect(directory.getById('n1')?.path).toBe('A/x.md')

    await client.deleteFile('n1')
    await client.createFile('A/x.md')
    expect(await client.restoreFromTrash('n1')).toBe('A/x 1.md')
  })

  it('suppression definitive : seulement depuis la corbeille', async () => {
    const { client, directory } = makeClient([{ id: 'n1', path: 'x.md' }])
    await expect(client.deleteFilePermanently('n1')).rejects.toThrow()
    await client.deleteFile('n1')
    await client.deleteFilePermanently('n1')
    expect(directory.getById('n1')).toBeUndefined()
  })

  it('deleteFolder met tout le dossier a la corbeille et retire ses entrees', async () => {
    const { client, directory } = makeClient([
      { id: 'a', path: 'P/a.md' }, { id: 'b', path: 'P/S/b.md' }, { id: 'c', path: 'Q/c.md' },
    ])
    await client.createFolder('P/Vide')
    await client.deleteFolder('P')
    expect(directory.getById('a')?.path).toBe('.trash/P/a.md')
    expect(directory.getById('b')?.path).toBe('.trash/P/S/b.md')
    expect(directory.getById('c')?.path).toBe('Q/c.md')
    expect(directory.getFolders()).toEqual([])
  })

  it('les pieces jointes suivent la meme regle (meme id : les octets restent)', async () => {
    const { client, directory } = makeClient([{ id: 'img', path: 'attachments/Photo.png' }])
    await client.deleteFile('img')
    expect(directory.getById('img')?.path).toBe('.trash/attachments/Photo.png')
  })

  it('la corbeille est masquee : liste racine, documents, liens par nom', async () => {
    const { client } = makeClient([{ id: 'a', path: 'a.md' }, { id: 'p', path: 'attachments/Photo.png' }])
    await client.deleteFile('a')
    await client.deleteFile('p')
    expect(await client.list()).toEqual([])
    expect(await client.list('')).toEqual([])
    expect(client.documents).toEqual([])
    // Mais on peut la lister explicitement.
    expect(await client.list('.trash/')).toEqual(['.trash/a.md', '.trash/attachments/'])
    // Un lien par nom ne trouve pas une image de la corbeille.
    await expect(client.resolveAttachmentUrl('Photo.png')).resolves.toBe('/attachments/Photo.png')
    expect(client.linkTarget('attachments/Photo.png')).toBe('attachments/Photo.png')
  })
})
