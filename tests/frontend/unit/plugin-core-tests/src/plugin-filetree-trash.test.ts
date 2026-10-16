// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Explorateur et corbeille : supprimer un dossier le met a la corbeille avec
// tout son contenu, et la fenetre dit combien de fichiers partent.
import { describe, it, expect } from 'vitest'
import type { VaultAPI } from '@savoire/plugin-api'
import {
  collectFolder, deleteFolderDeep, emptyTrashRequest, filesLabel, listLevel,
  trashFolderRequest, trashSubPagesRequest,
} from '@savoire/plugin-filetree'

const TRASH = '.trash/'

/** Faux vault qui suit la regle de VaultClient : supprimer = renommer sous `.trash/`. */
function makeVault(files: string[]) {
  const docs = new Map<string, string>()
  files.forEach((f, i) => docs.set(`id${i}`, f))
  const vault: VaultAPI = {
    read: async () => '',
    readDocumentByPath: async () => '',
    write: async () => {},
    exists: async () => false,
    list: async (dir?: string) => {
      const prefix = dir ?? ''
      const visible = [...docs.values()].filter(p => prefix.startsWith(TRASH) || !p.startsWith(TRASH))
      return listLevel(visible, prefix)
    },
    resolveDocumentId: (path: string) => [...docs].find(([, p]) => p === path)?.[0],
    deleteFile: async (id: string) => {
      const p = docs.get(id)
      if (p && !p.startsWith(TRASH)) docs.set(id, TRASH + p)
    },
    deleteFolder: async () => {},
    listTrash: () => [...docs].filter(([, p]) => p.startsWith(TRASH))
      .map(([documentId, path]) => ({ documentId, path, originalPath: path.slice(TRASH.length) })),
  }
  return { vault, paths: () => [...docs.values()].sort() }
}

describe('suppression d\'un dossier : corbeille', () => {
  it('compte les fichiers a toute profondeur, pour la fenetre', async () => {
    const { vault } = makeVault(['P/a.md', 'P/S/b.md', 'Q.md'])
    const { files } = await collectFolder(vault, 'P/')
    expect(files.length).toBe(2)
  })

  it('deleteFolderDeep met tout a la corbeille, chemins d\'origine gardes', async () => {
    const { vault, paths } = makeVault(['P/a.md', 'P/S/b.md', 'Q.md'])
    await deleteFolderDeep(vault, 'P/')
    expect(paths()).toEqual(['.trash/P/S/b.md', '.trash/P/a.md', 'Q.md'])
    // L'arborescence ne montre plus ni le dossier ni la corbeille.
    expect(await vault.list('')).toEqual(['Q.md'])
    expect(vault.listTrash!().map(e => e.originalPath).sort()).toEqual(['P/S/b.md', 'P/a.md'])
  })
})

describe('textes des fenetres', () => {
  it('disent « corbeille » et combien de fichiers', () => {
    expect(filesLabel(1)).toBe('1 fichier')
    expect(filesLabel(3)).toBe('3 fichiers')
    const folder = trashFolderRequest('Projet', 3)
    expect(folder.message).toContain('3 fichiers')
    expect(folder.message).toContain('corbeille')
    expect(folder.confirmLabel).toBe('Mettre a la corbeille')
    expect(trashFolderRequest('Vide', 0).confirmLabel).toBe('Retirer')
    const sub = trashSubPagesRequest('Projet', 2)
    expect(sub.message).toContain('2 elements')
    expect(sub.altLabel).toBe('Garder le dossier')
    expect(emptyTrashRequest(4).message).toContain('4 fichiers')
  })
})
