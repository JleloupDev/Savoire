// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import { describe, it, expect } from 'vitest'
import { parseFrontmatter } from '../frontmatter'
import {
  setFrontmatterValue, removeFrontmatterKey, renameFrontmatterKey, frontmatterKeys,
  formatYamlScalar, minimalTextChange,
} from '../frontmatterEdit'
import type { FrontmatterValue } from '../frontmatter'

const NOTE = [
  '---',
  '# en-tete garde',
  'title: "Projet: Alpha"',
  'status: En cours # a revoir',
  'priority: 2',
  'tags:',
  '  - urgent',
  '  - client',
  'aliases: [Alpha, "A, B"]',
  'nested:',
  '  child: 1',
  'inconnue: garde-moi',
  '---',
  '# Titre',
  '',
  'Corps de la note.',
].join('\n')

describe('frontmatterEdit', () => {
  it('remplace une valeur a sa place, sans toucher au reste', () => {
    const out = setFrontmatterValue(NOTE, 'priority', 5)
    expect(out).toBe(NOTE.replace('priority: 2', 'priority: 5'))
    expect(parseFrontmatter(out).priority).toBe(5)
  })

  it('garde le commentaire de fin de ligne', () => {
    const out = setFrontmatterValue(NOTE, 'status', 'Terminé')
    expect(out).toContain('status: Terminé # a revoir')
  })

  it('ajoute une cle a la fin du bloc', () => {
    const out = setFrontmatterValue(NOTE, 'due', '2026-11-03')
    expect(out).toBe(NOTE.replace('inconnue: garde-moi\n---', 'inconnue: garde-moi\ndue: 2026-11-03\n---'))
  })

  it('cree le bloc s il manque', () => {
    expect(setFrontmatterValue('# Note\n', 'done', true)).toBe('---\ndone: true\n---\n# Note\n')
    expect(setFrontmatterValue('', 'tags', ['a'])).toBe('---\ntags:\n  - a\n---\n')
  })

  it('bloc vide', () => {
    expect(setFrontmatterValue('---\n---\nx', 'a', 1)).toBe('---\na: 1\n---\nx')
  })

  it('liste en bloc : garde l indentation ; liste en ligne : reste en ligne', () => {
    const block = setFrontmatterValue(NOTE, 'tags', ['urgent', 'interne', 'client'])
    expect(block).toContain('tags:\n  - urgent\n  - interne\n  - client\naliases:')
    const inline = setFrontmatterValue(NOTE, 'aliases', ['Alpha', 'C'])
    expect(inline).toContain('aliases: [Alpha, C]\n')
    const flat = setFrontmatterValue('---\ntags:\n- a\n---\n', 'tags', ['a', 'b'])
    expect(flat).toBe('---\ntags:\n- a\n- b\n---\n')
  })

  it('liste vide puis remplie', () => {
    const empty = setFrontmatterValue(NOTE, 'tags', [])
    expect(empty).toContain('tags: []\naliases:')
    expect(parseFrontmatter(empty).tags).toEqual([])
    const again = setFrontmatterValue(empty, 'tags', ['x'])
    expect(parseFrontmatter(again).tags).toEqual(['x'])
  })

  it('une liste remplace une valeur simple et inversement', () => {
    const list = setFrontmatterValue(NOTE, 'priority', ['a', 'b'])
    expect(parseFrontmatter(list).priority).toEqual(['a', 'b'])
    const scalar = setFrontmatterValue(list, 'priority', 3)
    expect(scalar).toBe(NOTE.replace('priority: 2', 'priority: 3'))
  })

  it('aller-retour sans perte sur tous les types', () => {
    const values: Record<string, FrontmatterValue> = {
      texte: 'Bonjour',
      deuxpoints: 'Projet: Beta',
      guillemets: 'il a dit "oui"',
      diese: 'a #b',
      nombre: 3.25,
      negatif: -4,
      chiffresEnTexte: '42',
      vraiEnTexte: 'true',
      booleen: false,
      date: '2026-11-03',
      dateHeure: '2026-11-03T10:30:00',
      lien: '[[Beta]]',
      vide: null,
      choix: ['un', 'deux, trois', '[[Gamma]]', '7'],
      accents: 'Été à Noël',
      espaces: '  bord  ',
    }
    let md = NOTE
    for (const [k, v] of Object.entries(values)) md = setFrontmatterValue(md, k, v)
    const read = parseFrontmatter(md)
    for (const [k, v] of Object.entries(values)) expect(read[k], k).toEqual(v)
    // Le reste du bloc et le corps n'ont pas bouge.
    expect(md).toContain('# en-tete garde\n')
    expect(md).toContain('nested:\n  child: 1\n')
    expect(md.endsWith('---\n# Titre\n\nCorps de la note.')).toBe(true)
  })

  it('cle avec espaces, accents ou caractere special', () => {
    let md = setFrontmatterValue('', 'Échéance du projet', '2026-12-01')
    md = setFrontmatterValue(md, '-moins', 'x')
    expect(md).toContain('"-moins": x')
    expect(parseFrontmatter(md)).toEqual({ 'Échéance du projet': '2026-12-01', '-moins': 'x' })
    md = setFrontmatterValue(md, '-moins', 'y')
    expect(parseFrontmatter(md)['-moins']).toBe('y')
  })

  it('retire une cle et ses lignes ; le bloc vide disparait', () => {
    const out = removeFrontmatterKey(NOTE, 'tags')
    expect(out).toBe(NOTE.replace('tags:\n  - urgent\n  - client\n', ''))
    const last = removeFrontmatterKey(NOTE, 'inconnue')
    expect(last).toBe(NOTE.replace('\ninconnue: garde-moi', ''))
    expect(removeFrontmatterKey('---\na: 1\n---\nCorps', 'a')).toBe('Corps')
    // Un commentaire seul garde le bloc.
    expect(removeFrontmatterKey('---\n# note\na: 1\n---\nCorps', 'a')).toBe('---\n# note\n---\nCorps')
    expect(removeFrontmatterKey(NOTE, 'absente')).toBe(NOTE)
  })

  it('renomme sans toucher a la valeur ; refuse un nom deja pris', () => {
    const out = renameFrontmatterKey(NOTE, 'tags', 'étiquettes')
    expect(out).toBe(NOTE.replace('tags:\n', 'étiquettes:\n'))
    expect(parseFrontmatter(out)['étiquettes']).toEqual(['urgent', 'client'])
    expect(renameFrontmatterKey(NOTE, 'tags', 'status')).toBe(NOTE)
    expect(renameFrontmatterKey(NOTE, 'absente', 'x')).toBe(NOTE)
  })

  it('fins de ligne Windows conservees', () => {
    const crlf = NOTE.replace(/\n/g, '\r\n')
    const out = setFrontmatterValue(setFrontmatterValue(crlf, 'tags', ['a', 'b', 'c']), 'neuve', 1)
    expect(out.replace(/\r\n/g, '')).not.toContain('\n')
    expect(parseFrontmatter(out).tags).toEqual(['a', 'b', 'c'])
    expect(parseFrontmatter(out).neuve).toBe(1)
    expect(parseFrontmatter(removeFrontmatterKey(out, 'tags')).tags).toBeUndefined()
  })

  it('cle en double : on edite la derniere, celle que lit parseFrontmatter', () => {
    const md = '---\na: 1\na: 2\n---\n'
    expect(setFrontmatterValue(md, 'a', 3)).toBe('---\na: 1\na: 3\n---\n')
  })

  it('frontmatterKeys suit l ordre du texte', () => {
    expect(frontmatterKeys(NOTE)).toEqual(['title', 'status', 'priority', 'tags', 'aliases', 'nested', 'inconnue'])
  })

  it('formatYamlScalar met des guillemets quand il le faut', () => {
    expect(formatYamlScalar('simple')).toBe('simple')
    expect(formatYamlScalar('12')).toBe('"12"')
    expect(formatYamlScalar('[[Note]]')).toBe('"[[Note]]"')
    expect(formatYamlScalar('')).toBe('""')
    expect(formatYamlScalar(null)).toBe('')
  })

  it('minimalTextChange ne touche que la difference', () => {
    expect(minimalTextChange('abcdef', 'abXYef')).toEqual({ from: 2, to: 4, insert: 'XY' })
    expect(minimalTextChange('aaa', 'aaaa')).toEqual({ from: 3, to: 3, insert: 'a' })
    expect(minimalTextChange('same', 'same')).toBeNull()
    const before = setFrontmatterValue(NOTE, 'priority', 2)
    const after = setFrontmatterValue(NOTE, 'priority', 9)
    const c = minimalTextChange(before, after)!
    expect(c.to - c.from).toBe(1)
    expect(c.insert).toBe('9')
    // Une paire de substitution n'est pas coupee.
    const e = minimalTextChange('a😀b', 'a😃b')!
    expect('a😀b'.slice(0, e.from) + e.insert + 'a😀b'.slice(e.to)).toBe('a😃b')
    expect(e.insert.length).toBe(2)
  })
})
