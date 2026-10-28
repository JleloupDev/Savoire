// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import { describe, it, expect } from 'vitest'
import { findFrontmatter, parseFrontmatter, stripFrontmatter } from '../frontmatter'

describe('frontmatter', () => {
  it('lit les types courants', () => {
    const md = [
      '---',
      'title: "Projet: Alpha"',
      'status: En cours',
      'priority: 2',
      'ratio: 0.5',
      'done: false',
      'due: 2026-11-03',
      'empty:',
      'none: null',
      'due date: 2026-12-01 # commentaire',
      "quote: 'l''ete'",
      'tags: [urgent, "client, important"]',
      'aliases:',
      '  - Alpha',
      '  - "A"',
      'related:',
      '- "[[Beta]]"',
      'nested:',
      '  child: 1',
      '---',
      '# Titre',
    ].join('\n')
    expect(parseFrontmatter(md)).toEqual({
      title: 'Projet: Alpha',
      status: 'En cours',
      priority: 2,
      ratio: 0.5,
      done: false,
      due: '2026-11-03',
      empty: null,
      none: null,
      'due date': '2026-12-01',
      quote: "l'ete",
      tags: ['urgent', 'client, important'],
      aliases: ['Alpha', 'A'],
      related: ['[[Beta]]'],
      nested: null,
    })
  })

  it('bloc et texte sans frontmatter', () => {
    const md = '---\r\na: 1\r\n---\r\nCorps'
    expect(findFrontmatter(md)).toMatchObject({ yaml: 'a: 1', start: 0 })
    expect(stripFrontmatter(md)).toBe('Corps')
    expect(parseFrontmatter('# Pas de frontmatter\n---\na: 1\n---')).toEqual({})
    expect(parseFrontmatter('---\n---\n')).toEqual({})
    expect(stripFrontmatter('Texte')).toBe('Texte')
  })
})
