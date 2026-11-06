// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import { describe, it, expect } from 'vitest'
import {
  ReferenceParser, addNote, emptyIndex, extractVerses, suggest, DEFAULT_SETTINGS,
  referenceBelowSelection, referencesInDocument, triggerPattern,
} from '@savoire/plugin-quickref'

// Comme le vault JW : fins de ligne Windows, marqueur colle au texte.
const GENESE_1 = [
  '---', 'tags:', '- Bible/Chapter', 'aliases:', '- Genese 1', '- Gen 1', '---',
  '*Au commencement, Dieu créa le ciel et la terre.*', '*Genèse 1 : 1*^1', '',
  '*La terre était informe et déserte.*', '*Genèse 1 : 2*^2', '',
  '*Et Dieu dit : « Qu’il y ait de la lumière. »*', '*Genèse 1 : 3*^3', '',
].join('\r\n')
const GENESE_2 = '---\ntags:\n- Bible/Chapter\n---\n*Ainsi furent achevés le ciel et la terre.*\n*Genèse 2 : 1*^1\n'
const GENESE = '---\ntags:\n- Bible/Book\naliases:\n- Gn\n---\n[[Genèse 1]]\n[[Genèse 2]]\n'
const CHRON = '---\ntags:\n- Bible/Book\n---\n[[1 Chroniques 1]]\n'
const CHRON_1 = '---\ntags:\n- Bible/Chapter\n---\n*Adam, Seth, Énosh.*\n*1 Chroniques 1 : 1*^1\n'

function setup() {
  const index = emptyIndex()
  addNote(index, 'Bible/01 - Genèse/Genèse 1.md', GENESE_1)
  addNote(index, 'Bible/01 - Genèse/Genèse 2.md', GENESE_2)
  addNote(index, 'Bible/01 - Genèse/Genèse.md', GENESE)
  addNote(index, 'Bible/13 - 1 Chroniques/1 Chroniques.md', CHRON)
  addNote(index, 'Bible/13 - 1 Chroniques/1 Chroniques 1.md', CHRON_1)
  const parser = new ReferenceParser(index, ':')
  const link = (path: string) => path.slice(path.lastIndexOf('/') + 1).replace(/\.md$/, '')
  return { index, parser, link }
}

describe('plugin-quickref : lecture des chapitres', () => {
  it('lit les versets, sans frontmatter ni asterisques', () => {
    const { index } = setup()
    const g1 = index.byName.get('Genèse 1')!
    expect(g1.lastVerse).toBe(3)
    expect(g1.verses.get(1)).toBe('Au commencement, Dieu créa le ciel et la terre.')
    expect(index.byName.get('Genèse')!.lastVerse).toBe(0)
  })

  it('un bloc sans marqueur n\'est pas un verset', () => {
    expect([...extractVerses('Introduction\n\n*Texte*\n*Ref*^4').keys()]).toEqual([4])
  })
})

describe('plugin-quickref : references', () => {
  it('chapitre par nom, alias, abreviation de livre', () => {
    const { parser } = setup()
    expect(parser.resolveChapter('Gen 1')?.info.name).toBe('Genèse 1')
    expect(parser.resolveChapter('genese1')?.info.name).toBe('Genèse 1')
    expect(parser.resolveChapter('Gn 2')?.info.name).toBe('Genèse 2')
    expect(parser.resolveChapter('1 Chro 1')?.info.name).toBe('1 Chroniques 1')
    expect(parser.resolveChapter('Exode 1')).toBeNull()
  })

  it('versets, suites, listes, autre chapitre, plusieurs groupes', () => {
    const { parser } = setup()
    const verses = (s: string) => parser.parse(s)?.targets.map(t => `${t.info.name}:${t.verse}`)
    expect(verses('Gen 1:2')).toEqual(['Genèse 1:2'])
    expect(verses('Gen 1:1-3')).toEqual(['Genèse 1:1', 'Genèse 1:2', 'Genèse 1:3'])
    expect(verses('Gen 1:1-9')).toEqual(['Genèse 1:1', 'Genèse 1:2', 'Genèse 1:3'])
    expect(verses('Gen 1:1,3')).toEqual(['Genèse 1:1', 'Genèse 1:3'])
    expect(verses('Gen 1:3, 2:1')).toEqual(['Genèse 1:3', 'Genèse 2:1'])
    expect(verses('Gen 1:3 ; 2:1 ; 1 Chro 1:1')).toEqual(['Genèse 1:3', 'Genèse 2:1', '1 Chroniques 1:1'])
    expect(parser.parse('Gen 1:9')).toBeNull()
    expect(parser.parse('page 12')).toBeNull()
  })
})

describe('plugin-quickref : menu', () => {
  const s = DEFAULT_SETTINGS

  it('« ! » ne se declenche ni sur « ![[ » ni apres un mot', () => {
    const re = triggerPattern('!')
    expect('!Gen 1:3'.match(re)?.[1]).toBe('Gen 1:3')
    expect('texte !gn'.match(re)?.[1]).toBe('gn')
    expect('![[Genèse 1]]'.match(re)).toBeNull()
    expect('Bonjour!ok'.match(re)).toBeNull()
    expect('!g'.match(re)).toBeNull()
  })

  it('chapitres, puis completion qui garde le menu ouvert', () => {
    const { parser, link } = setup()
    const items = suggest(parser, 'gen', s, link)
    expect(items.map(i => i.label)).toEqual(['Genèse', 'Genèse 1', 'Genèse 2'])
    const g1 = items.find(i => i.label === 'Genèse 1')!
    expect(g1.insert).toBe('!Genèse 1:')
    expect(g1.keepOpen).toBe(true)
    // Un livre (sans versets) : un lien vers sa note.
    expect(items[0].insert).toBe('![[Genèse|Genèse]]')
  })

  it('apres « : » tous les versets ; un numero ; un mot dans le chapitre', () => {
    const { parser, link } = setup()
    expect(suggest(parser, 'Gen 1:', s, link).map(i => i.label)).toEqual(['Gen 1:1', 'Gen 1:2', 'Gen 1:3'])
    const one = suggest(parser, 'Gen 1:2-3', s, link)
    expect(one).toHaveLength(1)
    expect(one[0].insert).toBe('![[Genèse 1#^2]]\n![[Genèse 1#^3]]')
    expect(suggest(parser, 'Gen 1:lumiere', s, link).map(i => i.label)).toEqual(['Gen 1:3'])
  })

  it('un mot sans chapitre : toute la Bible, accents ignores', () => {
    const { parser, link } = setup()
    expect(suggest(parser, 'terre', s, link).map(i => i.label)).toEqual(['Genèse 1:1', 'Genèse 1:2', 'Genèse 2:1'])
    expect(suggest(parser, 'enosh', s, link).map(i => i.label)).toEqual(['1 Chroniques 1:1'])
  })
})

describe('plugin-quickref : commandes', () => {
  it('la reference selectionnee : ses versets sous la ligne', () => {
    const { parser, link } = setup()
    const text = 'Lire Gen 1:1,3 ce soir.\nSuite'
    const from = text.indexOf('Gen')
    const r = referenceBelowSelection(text, from, from + 'Gen 1:1,3'.length, parser, link)
    expect(r).toEqual({ ok: true, count: 2, insertion: { at: 23, insert: '\n![[Genèse 1#^1]]\n![[Genèse 1#^3]]' } })
    expect(referenceBelowSelection(text, 0, 4, parser, link)).toEqual({ ok: false, reason: 'unknown', text: 'Lire' })
    expect(referenceBelowSelection(text, 3, 3, parser, link).ok).toBe(false)
  })

  it('tout le document : parentheses reconnues, une seule fois', () => {
    const { parser, link } = setup()
    const text = 'Q1 (Gen 1:2 ; 2:1) ?\nQ2 (voir p. 12)\nQ3 (Gn 1:3)'
    const r = referencesInDocument(text, parser, link)
    expect(r.verses).toBe(3)
    expect(r.lines).toBe(2)
    let done = text
    for (const i of [...r.insertions].reverse()) done = done.slice(0, i.at) + i.insert + done.slice(i.at)
    expect(done).toBe('Q1 (Gen 1:2 ; 2:1) ?\n![[Genèse 1#^2]]\n![[Genèse 2#^1]]\nQ2 (voir p. 12)\nQ3 (Gn 1:3)\n![[Genèse 1#^3]]')
    // Relancee : rien de plus.
    expect(referencesInDocument(done, parser, link).verses).toBe(0)
  })
})
