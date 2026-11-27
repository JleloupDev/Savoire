// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// Favoris : une liste par personne et par vault, une note retenue par son id.
import { describe, expect, it } from 'vitest'
import { BookmarkStore, moveBookmark, sameBookmark, toggleBookmark } from '../../../../../packages/plugins/plugin-bookmarks/src/bookmarkStore'
import { headingAbove } from '../../../../../packages/plugins/plugin-bookmarks/src/index'

function memory() {
  const data = new Map<string, string>()
  return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => { data.set(k, v) } }
}

describe('favoris', () => {
  it('ajoute puis retire ; une note renommee reste la meme par son id', () => {
    const a = { type: 'file' as const, docId: 'd1', path: 'A.md' }
    const r1 = toggleBookmark([], a)
    expect(r1).toEqual({ list: [a], added: true })
    expect(sameBookmark(a, { type: 'file', docId: 'd1', path: 'Renommée.md' })).toBe(true)
    expect(sameBookmark(a, { type: 'file', docId: 'd1', path: 'A.md', subpath: 'Partie' })).toBe(false)
    expect(toggleBookmark(r1.list, { type: 'file', docId: 'd1', path: 'B.md' }).list).toEqual([])
  })

  it('une liste par vault et par personne, gardee', () => {
    const storage = memory()
    const s = new BookmarkStore(storage)
    s.attach('v1', 'u1')
    s.toggle({ type: 'url', url: 'https://example.org' })
    s.attach('v2', 'u1')
    expect(s.all()).toEqual([])
    const again = new BookmarkStore(storage)
    again.attach('v1', 'u1')
    expect(again.all()).toEqual([{ type: 'url', url: 'https://example.org' }])
    again.attach('v1', 'u2')
    expect(again.all()).toEqual([])
  })

  it('deplace un favori et trouve le titre au-dessus du curseur', () => {
    const list = [{ type: 'folder' as const, path: 'A/' }, { type: 'folder' as const, path: 'B/' }]
    expect(moveBookmark(list, 1, -1).map(b => b.path)).toEqual(['B/', 'A/'])
    expect(moveBookmark(list, 0, -1)).toEqual(list)
    expect(headingAbove(['# Titre', 'texte', '## Partie 2 ##', 'ici'], 3)).toBe('Partie 2')
    expect(headingAbove(['texte'], 0)).toBeNull()
  })
})
