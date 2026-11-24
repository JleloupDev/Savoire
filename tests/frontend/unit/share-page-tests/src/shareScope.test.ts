// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import { describe, it, expect } from 'vitest'
import { linkedPages, subpagesOf } from '../../../../../apps/web/src/shareScope'

const docs = [
  { id: 'p', path: 'A/Projet.md' },
  { id: 's', path: 'A/Projet/Sous.md' },
  { id: 'i', path: 'A/Projet/img/Photo.png' },
  { id: 'o', path: 'A/Projet bis.md' },
  { id: 'l1', path: 'B/Liee.md' },
  { id: 'l2', path: 'C/Plus loin.md' },
  { id: 'l3', path: 'C/Rapport.pdf' },
  { id: 'n', path: 'D/Jamais.md' },
]

const texts: Record<string, string> = {
  p: 'Voir [[Liee]] et ![[Photo.png]].\n```\n[[Jamais]] dans le code\n```\n`[[Jamais]]` aussi',
  l1: 'Puis [plus loin](../C/Plus%20loin.md), et [[A/Projet]] (deja vu).',
  l2: 'Le [[Rapport.pdf]] et un [site](https://exemple.org).',
  l3: '[[Jamais]]',
}

describe('sous-pages d une page', () => {
  it('tout ce qui est range dans son dossier, a toute profondeur', () => {
    expect(subpagesOf(docs[0], docs).map(d => d.id)).toEqual(['i', 's'])
  })
})

describe('pages liees, de proche en proche', () => {
  it('suit les liens [[...]], ![[...]] et Markdown, hors code et hors sites', async () => {
    const read = async (id: string) => texts[id] ?? ''
    const found = await linkedPages(docs[0], docs, read)
    expect(found.map(d => d.id).sort()).toEqual(['i', 'l1', 'l2', 'l3'])
  })

  it('ne lit pas un PDF ni une image', async () => {
    const reads: string[] = []
    await linkedPages(docs[0], docs, async id => { reads.push(id); return texts[id] ?? '' })
    expect(reads).not.toContain('l3')
    expect(reads).not.toContain('i')
  })

  it('s arrete a la limite', async () => {
    const found = await linkedPages(docs[0], docs, async id => texts[id] ?? '', 2)
    expect(found).toHaveLength(2)
  })
})
