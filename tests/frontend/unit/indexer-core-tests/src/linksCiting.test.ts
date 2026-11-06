// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// links.citing : les notes dont un lien vise un fichier de ce nom (image ou
// note, resolu ou non). Sert a recrire les liens apres un deplacement sans
// relire tout le vault.
import { describe, it, expect } from 'vitest'
import { memoryIndex } from './helpers'

type Items = { items: { id: string; path: string }[] }

describe('links.citing', () => {
  it('trouve les notes qui citent une image ou une note, par nom, casse ignoree', async () => {
    const index = await memoryIndex()
    await index.applyDocs([
      { id: 'a', path: 'A.md', content: 'Voir ![[Note/Photo.png]] et [[Projet]].' },
      { id: 'b', path: 'Dossier/B.md', content: '![[photo.png|200]]' },
      { id: 'c', path: 'C.md', content: '[[Projet.md#Titre]] et ![](images/autre.png)' },
      { id: 'd', path: 'D.md', content: 'Rien.' },
      { id: 'projet', path: 'Projet.md', content: '' },
    ])
    const ids = async (names: string[]) =>
      ((await index.call('links', 'citing', { names })) as Items).items.map(i => i.id).sort()
    expect(await ids(['photo.png'])).toEqual(['a', 'b'])
    expect(await ids(['projet', 'projet.md'])).toEqual(['a', 'c'])
    expect(await ids(['autre.png'])).toEqual(['c'])
    expect(await ids(['absente.png'])).toEqual([])
    await expect(index.call('links', 'citing', { names: [] })).rejects.toBeTruthy()
  })
})
