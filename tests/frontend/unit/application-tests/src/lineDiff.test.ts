// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Accepter une suggestion de texte ligne par ligne.
import { describe, it, expect } from 'vitest'
import { lineHunks, mergeHunks } from '@savoire/application'

const before = ['Titre', 'Ligne un', 'Ligne deux', 'Ligne trois', 'Fin'].join('\n')
const after = ['Titre', 'Ligne 1', 'Ligne deux', 'Ligne trois', 'Ajout', 'Fin'].join('\n')

describe('lineHunks / mergeHunks', () => {
  it('decoupe en blocs de lignes changees', () => {
    expect(lineHunks(before, after)).toEqual([
      { index: 0, removed: ['Ligne un'], added: ['Ligne 1'] },
      { index: 1, removed: [], added: ['Ajout'] },
    ])
  })

  it('tous les blocs : le texte propose ; aucun : le passage', () => {
    expect(mergeHunks(before, after, [0, 1])).toBe(after)
    expect(mergeHunks(before, after, [])).toBe(before)
  })

  it('un seul bloc : le reste du passage est garde', () => {
    expect(mergeHunks(before, after, [1])).toBe(['Titre', 'Ligne un', 'Ligne deux', 'Ligne trois', 'Ajout', 'Fin'].join('\n'))
    expect(mergeHunks(before, after, [0])).toBe(['Titre', 'Ligne 1', 'Ligne deux', 'Ligne trois', 'Fin'].join('\n'))
  })

  it('suppressions et lignes vides', () => {
    const b = 'a\n\nb\nc\n', a = 'a\nb\n'
    const h = lineHunks(b, a)
    expect(h.map(x => x.removed)).toEqual([[''], ['c']])
    expect(mergeHunks(b, a, [1])).toBe('a\n\nb\n')
  })
})
