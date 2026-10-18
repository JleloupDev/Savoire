// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Diff de texte du vault sur disque : une modification faite ailleurs ne
// remplace que ce qui a change.
import { describe, expect, it } from 'vitest'
import { applyTextEdits, diffText } from '@savoire/infrastructure-sync'

describe('diffText', () => {
  it('rien a faire pour deux textes egaux', () => {
    expect(diffText('abc', 'abc')).toEqual([])
  })

  it('un mot change au milieu : seul ce mot bouge', () => {
    expect(diffText('un deux trois', 'un 2 trois')).toEqual([{ retain: 3 }, { delete: 4 }, { insert: '2' }])
  })

  it('deux lignes changees loin l\'une de l\'autre : deux modifications, le milieu garde', () => {
    const a = 'titre\n' + 'x\n'.repeat(50) + 'fin\n'
    const b = 'Titre\n' + 'x\n'.repeat(50) + 'Fin\n'
    const edits = diffText(a, b)
    expect(applyTextEdits(a, edits)).toBe(b)
    const deleted = edits.reduce((n, e) => n + ('delete' in e ? e.delete : 0), 0)
    expect(deleted).toBe(2)
  })

  it('lignes inserees et supprimees', () => {
    const a = 'a\nb\nc\nd\n'
    const b = 'a\nc\nnouveau\nd\ne'
    expect(applyTextEdits(a, diffText(a, b))).toBe(b)
  })

  it('ne coupe jamais une paire de substitution (emoji)', () => {
    const a = 'note 😀 fin'
    const b = 'note 😃 fin'
    const edits = diffText(a, b)
    expect(applyTextEdits(a, edits)).toBe(b)
    for (const e of edits) if ('insert' in e) expect(e.insert).toBe('😃')
  })

  it('textes vides et totalement differents', () => {
    expect(diffText('', 'abc')).toEqual([{ insert: 'abc' }])
    expect(diffText('abc', '')).toEqual([{ delete: 3 }])
    expect(applyTextEdits('xyz', diffText('xyz', 'abc'))).toBe('abc')
  })

  it('reste juste au-dela du cout maximal (repli sur un bloc)', () => {
    const a = Array.from({ length: 2000 }, (_, i) => `ligne ${i}\n`).join('')
    const b = Array.from({ length: 2000 }, (_, i) => `ligne ${i % 2 ? i : -i}\n`).join('')
    expect(applyTextEdits(a, diffText(a, b))).toBe(b)
  })
})
