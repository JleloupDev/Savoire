// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// plugin-base : calculs des totaux de colonnes.
import { describe, it, expect } from 'vitest'
import { computeTotal, totalText } from '@savoire/plugin-base'

describe('totaux de colonnes', () => {
  it('nombres seulement : un nombre ecrit en texte reste du texte ; vides ignores', () => {
    const v = [3, '4,5', null, '', 'abc', 0.1, 0.2]
    expect(computeTotal('sum', v)).toBe(3.3)
    expect(computeTotal('mean', [1, 2, 6])).toBe(3)
    expect(computeTotal('median', [5, 1, 3, 2])).toBe(2.5)
    expect(computeTotal('min', v)).toBe(0.1)
    expect(computeTotal('max', v)).toBe(3)
    // Sans aucun nombre : min et max des textes.
    expect(computeTotal('max', ['b', 'a', null])).toBe('b')
    expect(computeTotal('sum', ['a', null])).toBe(0)
    expect(computeTotal('mean', ['a'])).toBeNull()
  })

  it('comptes, cases, valeurs distinctes, dates', () => {
    expect(computeTotal('filled', ['a', null, '', [], ['x']])).toBe(2)
    expect(computeTotal('empty', ['a', null, '', [], ['x']])).toBe(3)
    expect(computeTotal('checked', [true, 'true', false, null])).toBe(2)
    expect(computeTotal('unchecked', [true, 'true', false, null])).toBe(2)
    expect(computeTotal('unique', ['Fait', 'fait', 'En cours', ['A', 'Fait'], null])).toBe(3)
    expect(computeTotal('min', ['2026-03-01', '2025-12-31', null])).toBe('2025-12-31')
    expect(computeTotal('max', ['2026-03-01', '2025-12-31'])).toBe('2026-03-01')
  })

  it('texte du pied', () => {
    expect(totalText('sum', 1234.5)).toMatch(/^Somme 1\s?234,5$/)
    expect(totalText('mean', null)).toBe('Moy. —')
  })
})
