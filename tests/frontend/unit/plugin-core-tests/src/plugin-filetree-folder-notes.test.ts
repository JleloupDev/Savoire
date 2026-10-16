// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import { describe, it, expect } from 'vitest'
import type { VaultAPI } from '@savoire/plugin-api'
import {
  buildPathTree,
  createSubPage,
  deleteFolderDeep,
  folderOfNote,
  groupEntries,
  listLevel,
  moveFolder,
  moveNote,
  uniqueChildPath,
} from '@savoire/plugin-filetree'

// ─── Faux vault en memoire, meme logique de listing que VaultClient ────────

function makeVault(files: string[], folders: string[] = []) {
  const docs = new Map<string, string>() // id -> chemin
  let next = 0
  for (const f of files) docs.set(`id${next++}`, f)
  const explicit = new Set(folders)
  const all = () => [...docs.values(), ...explicit]
  const vault: VaultAPI = {
    read: async () => '',
    readDocumentByPath: async () => '',
    write: async () => {},
    exists: async () => false,
    list: async (dir?: string) => listLevel(all(), dir ?? ''),
    resolveDocumentId: (path: string) => [...docs].find(([, p]) => p === path)?.[0],
    createFile: async (path: string) => { docs.set(`id${next++}`, path) },
    createFolder: async (path: string) => { explicit.add(path.endsWith('/') ? path : path + '/') },
    renameFile: async (id: string, newPath: string) => { docs.set(id, newPath) },
    deleteFile: async (id: string) => { docs.delete(id) },
    deleteFolder: async (path: string) => {
      for (const f of [...explicit]) if (f.startsWith(path)) explicit.delete(f)
    },
  }
  return { vault, paths: () => [...docs.values()].sort(), folders: () => [...explicit].sort() }
}

// ─── Fusion d'affichage ─────────────────────────────────────────────────────

describe('groupEntries', () => {
  it('fusionne un fichier et le dossier frere de meme nom', () => {
    const nodes = groupEntries(['Autre.md', 'Projet.page', 'Projet/'])
    expect(nodes).toEqual([
      { kind: 'file', name: 'Autre.md', path: 'Autre.md' },
      { kind: 'folderNote', name: 'Projet', path: 'Projet.page', fileName: 'Projet.page', folderPath: 'Projet/' },
    ])
  })

  it('laisse un fichier seul et un dossier seul tels quels', () => {
    expect(groupEntries(['A.md', 'B/'])).toEqual([
      { kind: 'file', name: 'A.md', path: 'A.md' },
      { kind: 'folder', name: 'B', path: 'B/' },
    ])
  })

  it('ne fusionne pas un fichier sans extension', () => {
    expect(groupEntries(['Projet', 'Projet/']).map(n => n.kind)).toEqual(['file', 'folder'])
  })

  it('prefere .page, puis .md, puis l\'ordre alphabetique', () => {
    const a = groupEntries(['Projet.md', 'Projet.page', 'Projet.txt', 'Projet/'])
    expect(a.find(n => n.kind === 'folderNote')?.path).toBe('Projet.page')
    expect(a.filter(n => n.kind === 'file').map(n => n.path)).toEqual(['Projet.md', 'Projet.txt'])

    const b = groupEntries(['Projet.md', 'Projet.txt', 'Projet/'])
    expect(b.find(n => n.kind === 'folderNote')?.path).toBe('Projet.md')

    const c = groupEntries(['Projet.txt', 'Projet.csv', 'Projet/'])
    expect(c.find(n => n.kind === 'folderNote')?.path).toBe('Projet.csv')
  })

  it('garde le nom complet quand le nom contient un point', () => {
    const nodes = groupEntries(['v1.2.md', 'v1.2/'])
    expect(nodes).toHaveLength(1)
    expect(nodes[0]).toMatchObject({ kind: 'folderNote', name: 'v1.2', folderPath: 'v1.2/' })
  })
})

describe('buildPathTree', () => {
  it('construit un arbre imbrique avec notes de dossier', () => {
    const tree = buildPathTree([
      'Projet.page',
      'Projet/Enfant.page',
      'Projet/Enfant/Petit.page',
      'Projet/Notes.md',
      'Vide/',
    ])
    expect(tree).toHaveLength(2)
    const projet = tree[0]
    expect(projet).toMatchObject({ kind: 'folderNote', path: 'Projet.page', folderPath: 'Projet/' })
    expect(projet.children?.map(c => [c.kind, c.path])).toEqual([
      ['folderNote', 'Projet/Enfant.page'],
      ['file', 'Projet/Notes.md'],
    ])
    expect(projet.children?.[0].children?.map(c => c.path)).toEqual(['Projet/Enfant/Petit.page'])
    expect(tree[1]).toMatchObject({ kind: 'folder', path: 'Vide/', children: [] })
  })
})

describe('chemins utilitaires', () => {
  it('folderOfNote donne le dossier frere', () => {
    expect(folderOfNote('A/Projet.page')).toBe('A/Projet/')
    expect(folderOfNote('Projet')).toBe('')
  })

  it('uniqueChildPath evite les noms pris', () => {
    const taken = new Set(['P/Sans titre.page', 'P/Sans titre 2.page'])
    expect(uniqueChildPath('P/', 'page', taken)).toBe('P/Sans titre 3.page')
    expect(uniqueChildPath('P/', 'md', taken)).toBe('P/Sans titre.md')
  })
})

// ─── Operations sur le vault ────────────────────────────────────────────────

describe('createSubPage', () => {
  it('cree Projet/Sans titre.<meme extension>, le fichier devient note de dossier', async () => {
    const { vault, paths } = makeVault(['Projet.page'])
    const created = await createSubPage(vault, 'Projet.page', [])
    expect(created).toBe('Projet/Sans titre.page')
    expect(paths()).toEqual(['Projet.page', 'Projet/Sans titre.page'])
    const root = groupEntries(await vault.list(''))
    expect(root).toEqual([
      { kind: 'folderNote', name: 'Projet', path: 'Projet.page', fileName: 'Projet.page', folderPath: 'Projet/' },
    ])
  })

  it('numerote la deuxieme sous-page', async () => {
    const { vault } = makeVault(['Projet.md', 'Projet/Sans titre.md'])
    expect(await createSubPage(vault, 'Projet.md', [])).toBe('Projet/Sans titre 2.md')
  })

  it('ecrit le contenu initial du type de fichier', async () => {
    const { vault } = makeVault(['Projet.page'])
    const writes: string[] = []
    vault.write = async (_id, content) => { writes.push(content) }
    await createSubPage(vault, 'Projet.page', [
      { extension: 'page', label: 'Page', icon: 'P', create: async () => '{}', open: () => { throw new Error('non') } } as never,
    ])
    expect(writes).toEqual(['{}'])
  })
})

describe('moveNote', () => {
  it('renommer la note renomme aussi le dossier et les enfants', async () => {
    const { vault, paths } = makeVault(['Projet.page', 'Projet/A.page', 'Projet/A/B.md', 'Projet.md'])
    await moveNote(vault, 'Projet.page', 'Plan.page')
    expect(paths()).toEqual(['Plan.page', 'Plan/A.page', 'Plan/A/B.md', 'Projet.md'])
  })

  it('renomme un fichier sans dossier sans rien creer', async () => {
    const { vault, paths, folders } = makeVault(['A.md'])
    await moveNote(vault, 'A.md', 'B.md')
    expect(paths()).toEqual(['B.md'])
    expect(folders()).toEqual([])
  })

  it('deplace une note et son dossier dans un autre dossier', async () => {
    const { vault, paths } = makeVault(['Projet.md', 'Projet/X.md', 'Archive/Old.md'])
    await moveNote(vault, 'Projet.md', 'Archive/Projet.md')
    expect(paths()).toEqual(['Archive/Old.md', 'Archive/Projet.md', 'Archive/Projet/X.md'])
  })

  it('refuse de ranger une note dans son propre dossier', async () => {
    const { vault, paths } = makeVault(['Projet.md', 'Projet/X.md'])
    await expect(moveNote(vault, 'Projet.md', 'Projet/Projet.md')).rejects.toThrow()
    expect(paths()).toEqual(['Projet.md', 'Projet/X.md'])
  })

  it('refuse un conflit sans rien changer', async () => {
    const { vault, paths } = makeVault(['Projet.md', 'Projet/X.md', 'Plan/X.md'])
    await expect(moveNote(vault, 'Projet.md', 'Plan.md')).rejects.toThrow()
    expect(paths()).toEqual(['Plan/X.md', 'Projet.md', 'Projet/X.md'])
  })
})

describe('moveFolder', () => {
  it('garde les sous-dossiers vides', async () => {
    const { vault, paths, folders } = makeVault(['D/a.md'], ['D/', 'D/Vide/'])
    await moveFolder(vault, 'D/', 'E/')
    expect(paths()).toEqual(['E/a.md'])
    expect(folders()).toEqual(['E/Vide/'])
  })
})

describe('deleteFolderDeep', () => {
  it('supprime les sous-pages et le dossier', async () => {
    const { vault, paths, folders } = makeVault(['Projet.md', 'Projet/A.md', 'Projet/B/C.md'], ['Projet/'])
    await deleteFolderDeep(vault, 'Projet/')
    expect(paths()).toEqual(['Projet.md'])
    expect(folders()).toEqual([])
  })
})
