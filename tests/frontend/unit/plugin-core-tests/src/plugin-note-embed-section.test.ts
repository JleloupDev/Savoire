// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import { describe, it, expect } from 'vitest'
import { extractSubpath, parseSubpath, stripBlockIds } from '@savoire/plugin-note-embed'

const NOTE = [
  '# Projet',
  '',
  'Intro.',
  '',
  '## Objectifs',
  '',
  'Livrer vite. ^obj',
  '',
  '### Detail',
  '',
  'Un detail.',
  '',
  '## Risques',
  '',
  '- Retard ^r1',
  '  - Fournisseur',
  '- Budget',
  '',
  '| a | b |',
  '|---|---|',
  '| 1 | 2 |',
  '',
  '^table',
  '',
  '```md',
  '## Pas un titre',
  'code ^code',
  '```',
  '',
  '## Annexe',
  'Ligne une',
  'ligne deux ^para',
].join('\n')

const heading = (...headings: string[]) => extractSubpath(NOTE, { kind: 'heading', headings })
const block = (id: string) => extractSubpath(NOTE, { kind: 'block', id })

describe('parseSubpath', () => {
  it('reads a heading chain', () => expect(parseSubpath('A#B')).toEqual({ kind: 'heading', headings: ['A', 'B'] }))
  it('reads a block id', () => expect(parseSubpath('^x1')).toEqual({ kind: 'block', id: 'x1' }))
  it('ignores an empty fragment', () => expect(parseSubpath(' ')).toBeNull())
})

describe('sections', () => {
  it('stops at the next heading of the same level, keeps sub-headings', () => {
    const s = heading('Objectifs')!
    expect(s.startsWith('## Objectifs')).toBe(true)
    expect(s).toContain('### Detail')
    expect(s).not.toContain('Risques')
    expect(s).not.toContain('^obj')
  })
  it('ignores case and spacing', () => expect(heading('  objectifs ')).toContain('Livrer vite.'))
  it('takes a sub-heading under its parent', () => expect(heading('Objectifs', 'Detail')).toBe('### Detail\n\nUn detail.'))
  it('refuses a chain in the wrong order', () => expect(heading('Risques', 'Detail')).toBeNull())
  it('does not see headings inside code', () => expect(heading('Pas un titre')).toBeNull())
  it('runs to the end of the note for the last section', () => expect(heading('Annexe')).toBe('## Annexe\nLigne une\nligne deux'))
  it('returns null for an unknown heading', () => expect(heading('Absent')).toBeNull())
})

describe('blocks', () => {
  it('takes a paragraph', () => expect(block('obj')).toBe('Livrer vite.'))
  it('takes a multi-line paragraph', () => expect(block('para')).toBe('Ligne une\nligne deux'))
  it('takes a list item with its children', () => expect(block('r1')).toBe('- Retard\n  - Fournisseur'))
  it('takes the block above a standalone id', () => expect(block('table')).toBe('| a | b |\n|---|---|\n| 1 | 2 |'))
  it('does not see ids inside code', () => expect(block('code')).toBeNull())
  it('returns null for an unknown id', () => expect(block('nope')).toBeNull())
})

describe('stripBlockIds', () => {
  it('hides markers but keeps code', () => {
    expect(stripBlockIds('a ^x\n^y\n```\nb ^z\n```')).toBe('a\n```\nb ^z\n```')
  })
  it('leaves footnotes and text alone', () => expect(stripBlockIds('x[^1] and 2^3')).toBe('x[^1] and 2^3'))
})
