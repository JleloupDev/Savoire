// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// plugin-bible : lire un chapitre de wol.jw.org, ecrire les notes, installer.
// Le HTML est fabrique sur le modele des pages du site (meme balisage), pas
// recopie : les textes sont inventes.
import { describe, it, expect } from 'vitest'
import {
  BIBLES, BOOKS, CHAPTER_COUNT, addNote, bookNote, chapterNote, chapterPath, emptyIndex, extractVerses,
  indexNote, installBible, installedBibleId, parseWolChapter, pieceText, wolChapterUrl, type BibleEdition,
} from '@savoire/plugin-bible'

const verse = (b: number, c: number, v: number, p: number, inner: string) =>
  `<span id="v${b}-${c}-${v}-${p}" class="v">${inner}</span>`

const PAGE = [
  '<header><h1>Psaumes</h1></header>',
  `<p class="sw">${verse(19, 3, 0, 1, 'Titre du psaume<a href="/bc/1" data-bid="1-1" class="b">+</a>.')}</p>`,
  `<p class="sl">${verse(19, 3, 1, 1, '<a href="/dx/1" class="cl vx vp"><strong>3</strong> </a>Premier vers,<a class="fn pr" href="/fn/1">*</a>')}</p>`,
  `<p class="sz">${verse(19, 3, 1, 2, 'second vers &amp; fin.')}</p>`,
  `<p>${verse(19, 3, 2, 1, ' <a href="/dx/2" class="vl vx vp">2 </a>Sont-​ils <em>là</em>&nbsp;? <span class="x">oui</span>')} `,
  `${verse(19, 3, 3, 1, '<a href="/dx/3" class="vl vx vp">3 </a>Un * étoile.')}</p>`,
  // Numero sans « vx » (verset sans renvoi), espace insecable conservee.
  `<p>${verse(19, 3, 4, 1, '<a href="/dx/4" class="vl vp">4 </a>Il dit\u00A0: «&nbsp;oui\u00A0». ')}</p>`,
  // Un autre chapitre sur la page (renvoi) : ignore.
  verse(19, 4, 1, 1, 'Ailleurs'),
].join('\n')

describe('plugin-bible : wol.jw.org', () => {
  it('adresse d\'un chapitre', () => {
    expect(BIBLES[0].chapterUrl(1, 1)).toBe('https://wol.jw.org/fr/wol/b/r30/lp-f/nwt/1/1')
    expect(wolChapterUrl({ language: 'en', rsconf: 'r1', lib: 'lp-e', publication: 'nwtsty' }, 19, 3)).toBe('https://wol.jw.org/en/wol/b/r1/lp-e/nwtsty/19/3')
  })

  it('versets, lignes de poesie, sans numeros, renvois ni appels de note', () => {
    expect(parseWolChapter(PAGE, 19, 3)).toEqual([
      { number: 0, lines: ['Titre du psaume.'] },
      { number: 1, lines: ['Premier vers,', 'second vers & fin.'] },
      { number: 2, lines: ['Sont-ils là\u00A0? oui'] },
      { number: 3, lines: ['Un * étoile.'] },
      { number: 4, lines: ['Il dit\u00A0: «\u00A0oui\u00A0».'] },
    ])
    expect(parseWolChapter(PAGE, 1, 1)).toEqual([])
    expect(pieceText('A&#233;&#x20AC;&bogus;')).toBe('Aé€&bogus;')
  })
})

describe('plugin-bible : notes', () => {
  const psaumes = BOOKS[18]

  it('66 livres, 1189 chapitres', () => {
    expect(BOOKS).toHaveLength(66)
    expect(CHAPTER_COUNT).toBe(1189)
    expect(BOOKS.map(b => b.number)).toEqual(Array.from({ length: 66 }, (_, i) => i + 1))
  })

  it('un chapitre ecrit se relit tel quel par l\'index', () => {
    const verses = parseWolChapter(PAGE, 19, 3)
    const text = chapterNote(psaumes, 3, verses)
    expect(text).toContain('*Premier vers,*\n*second vers & fin.*\n*Psaumes 3 : 1*^1\n\n')
    expect(text).toContain('*Un \\* étoile.*')
    const index = emptyIndex()
    addNote(index, chapterPath('Bible/', psaumes, 3), text)
    addNote(index, 'Bible/19 - Psaumes/Psaumes.md', bookNote(psaumes))
    expect(index.byName.get('Psaumes 3')!.verses.get(1)).toBe('Premier vers, second vers & fin.')
    expect(index.byName.get('Psaumes 3')!.lastVerse).toBe(4)
    expect(index.chapterAliases.get('ps3')).toBe('Psaumes 3')
    expect(index.bookAliases.get('ps')).toBe('Psaumes')
  })

  it('un verset de poesie a la main : toutes ses lignes', () => {
    const v = extractVerses('*Ligne un*\n*Ligne deux*\n*Psaumes 3 : 1*^1\n\n*Seul* ^2\n')
    expect(v.get(1)).toBe('Ligne un Ligne deux')
    expect(v.get(2)).toBe('Seul')
  })

  it('la note d\'index dit quelle Bible est installee', () => {
    const text = indexNote('Bible/', BOOKS.slice(0, 2), { id: 'tmn-fr', name: 'Traduction du monde nouveau (révision 2018)', source: 'wol.jw.org' })
    expect(text).toContain('- [[Bible/01 - Genèse/Genèse|Genèse]]')
    expect(installedBibleId(text)).toBe('tmn-fr')
    expect(installedBibleId('# Rien')).toBeNull()
    expect(installedBibleId(null)).toBeNull()
  })
})

describe('plugin-bible : installation', () => {
  const books = [BOOKS[30], BOOKS[56]] // Abdias, Philemon : un chapitre chacun
  const fakeBible: BibleEdition = {
    ...BIBLES[0],
    parseChapter: (html, book, chapter) => html === 'vide' ? [] : [{ number: 1, lines: [`${book}:${chapter}`] }],
  }

  function target(existing: string[] = [], pages: (url: string) => string = () => 'ok') {
    const notes = new Map<string, string>(existing.map(p => [p, 'deja']))
    const fetched: string[] = []
    return {
      notes, fetched,
      fetchText: async (url: string) => { fetched.push(url); return pages(url) },
      exists: (p: string) => notes.has(p),
      createNote: async (p: string, t: string) => { notes.set(p, t) },
    }
  }

  it('ecrit chapitres, livres et index ; garde ce qui existe', async () => {
    const t = target(['Bible/31 - Abdias/Abdias 1.md'])
    const seen: number[] = []
    const r = await installBible(t, fakeBible, { root: 'Bible/', books, onProgress: p => seen.push(p.done) })
    expect(r).toEqual({ written: 4, skipped: 1, cancelled: false })
    expect(t.fetched).toEqual(['https://wol.jw.org/fr/wol/b/r30/lp-f/nwt/57/1'])
    expect(t.notes.get('Bible/31 - Abdias/Abdias 1.md')).toBe('deja')
    expect(t.notes.get('Bible/57 - Philémon/Philémon 1.md')).toContain('*57:1*\n*Philémon 1 : 1*^1')
    expect(installedBibleId(t.notes.get('Bible/Bible.md'))).toBe('tmn-fr')
    expect(seen.at(-1)).toBe(5)
  })

  it('une page sans verset arrete tout, sans livre ni index', async () => {
    const t = target([], () => 'vide')
    await expect(installBible(t, fakeBible, { root: 'Bible/', books })).rejects.toThrow('Aucun verset lu')
    expect(t.notes.has('Bible/Bible.md')).toBe(false)
  })

  it('arretee : ce qui est ecrit reste, pas d\'index', async () => {
    const t = target()
    const r = await installBible(t, fakeBible, { root: 'Bible/', books, concurrency: 1, cancelled: () => t.notes.size >= 1 })
    expect(r.cancelled).toBe(true)
    expect(r.written).toBe(1)
    expect(t.notes.has('Bible/Bible.md')).toBe(false)
  })
})
