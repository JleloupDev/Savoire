// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Formules des bases (plugin-api/formula.ts), syntaxe proche de Notion.
import { describe, it, expect } from 'vitest'
import { compileFormula, tryCompileFormula } from '@savoire/plugin-api'
import type { FormulaRow, PropertyValue } from '@savoire/plugin-api'

const NOW = new Date('2026-10-31T15:30:00Z')
const row: FormulaRow = {
  title: 'Alpha',
  values: {
    Prix: 12.5, Quantité: '3', Fait: true, Statut: 'En cours', Début: '2026-10-01',
    Fin: '2026-12-15', Tags: ['a', 'b', 'a'], Vide: null,
  },
}
const run = (src: string, r: FormulaRow = row): PropertyValue => {
  const res = compileFormula(src).evaluate(r, NOW)
  if (!res.ok) throw new Error(res.error)
  return res.value
}
const error = (src: string): string => {
  const c = tryCompileFormula(src)
  if ('error' in c) return c.error
  const r = c.formula.evaluate(row, NOW)
  return r.ok ? '' : r.error
}

describe('formules', () => {
  it('calcul, priorites, texte', () => {
    expect(run('prop("Prix") * prop("Quantité")')).toBe(37.5)
    expect(run('1 + 2 * 3 ^ 2')).toBe(19)
    expect(run('-2 + 10 % 3')).toBe(-1)
    expect(run('prop("Statut") + " !"')).toBe('En cours !')
    expect(run('prop("Statut").upper()')).toBe('EN COURS')
    expect(run('length(prop("Statut"))')).toBe(8)
    expect(run('round(10 / 3, 2)')).toBe(3.33)
    expect(run('prop("Nom")')).toBe('Alpha')
    // Proprietes en texte (« 3 », « 3,5 ») : on calcule, on ne colle pas.
    const r2: FormulaRow = { title: 't', values: { c1: '3', c2: '5', c3: '3,5', vide: null } }
    expect(run('(2 * (prop("c1") + prop("c2")))/2', r2)).toBe(8)
    expect(run('prop("c3") + prop("c2")', r2)).toBe(8.5)
    expect(run('prop("vide") + prop("c2")', r2)).toBe(5)
    expect(run('concat(prop("c1"), prop("c2"))', r2)).toBe('35')
  })

  it('logique : if, ifs, ternaire, and/or/not, comparaisons', () => {
    expect(run('if(prop("Fait"), "✓", "")')).toBe('✓')
    expect(run('prop("Prix") > 10 ? "cher" : "ok"')).toBe('cher')
    expect(run('ifs(prop("Prix") < 5, "bas", prop("Prix") < 20, "moyen", "haut")')).toBe('moyen')
    expect(run('prop("Fait") and not empty(prop("Statut"))')).toBe(true)
    expect(run('prop("Statut") == "En cours" || false')).toBe(true)
    expect(run('empty(prop("Vide")) && empty(prop("Absente"))')).toBe(true)
    // La branche non choisie n'est pas calculee.
    expect(run('if(true, 1, 1 / 0)')).toBe(1)
  })

  it('dates', () => {
    expect(run('dateAdd(prop("Début"), 7, "days")')).toBe('2026-10-08')
    expect(run('dateAdd(prop("Début"), 1, "months")')).toBe('2026-11-01')
    expect(run('dateBetween(prop("Fin"), prop("Début"), "days")')).toBe(75)
    expect(run('dateBetween(prop("Fin"), prop("Début"), "months")')).toBe(2)
    expect(run('today()')).toBe('2026-10-31')
    expect(run('formatDate(prop("Début"), "DD/MM/YYYY")')).toBe('01/10/2026')
    expect(run('prop("Fin") > prop("Début")')).toBe(true)
    expect(run('year(now())')).toBe(2026)
  })

  it('listes', () => {
    expect(run('length(prop("Tags"))')).toBe(3)
    expect(run('prop("Tags").unique()')).toEqual(['a', 'b'])
    expect(run('contains(prop("Tags"), "b")')).toBe(true)
    expect(run('join(prop("Tags"), "-")')).toBe('a-b-a')
    expect(run('sum([1, 2, prop("Quantité")])')).toBe(6)
  })

  it('erreurs en francais, jamais de code JavaScript', () => {
    expect(error('prop("Prix") *')).toMatch(/incompl/i)
    expect(error('Prix * 2')).toMatch(/prop\("Prix"\)/)
    expect(error('alert(1)')).toMatch(/Fonction inconnue/)
    expect(error('constructor.constructor("x")')).toMatch(/inconnu/)
    expect(error('"abc')).toMatch(/non fermé/)
    expect(error('prop("Statut") * 2')).toMatch(/n'est pas un nombre/)
    expect(error('1 / 0')).toMatch(/impossible/)
    expect(error('dateAdd(prop("Début"), 1, "siècles")')).toMatch(/Unité inconnue/)
    expect(error('('.repeat(100) + '1' + ')'.repeat(100))).toMatch(/imbriqu/)
  })

  it('liste les proprietes lues', () => {
    expect(compileFormula('prop("A") + if(prop("B"), prop("C"), 0)').props).toEqual(['A', 'B', 'C'])
  })
})
