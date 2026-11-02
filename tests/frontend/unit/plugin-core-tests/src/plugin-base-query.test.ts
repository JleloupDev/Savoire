// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// plugin-base : bloc de requete ```base (from / where / select / sort / limit)
// et agregats (sum, mean, min, max, median, count).
import { describe, it, expect } from 'vitest'
import { parseBaseQuery, evaluateBaseQuery, BASE_QUERY_FENCE_RE } from '@savoire/plugin-base'
import type { BaseQuery } from '@savoire/plugin-base'
import type { QueryRow } from '@savoire/plugin-api'

const ROWS: QueryRow[] = [
  { id: '1', path: 'db/A.md', title: 'A', values: { id: 1, c1: 10, c2: '5', Statut: 'Fait', Fin: '2026-03-01' } },
  { id: '2', path: 'db/B.md', title: 'B', values: { id: 2, c1: 20, c2: '1', Statut: 'En cours', Fin: '2026-01-15' } },
  { id: '3', path: '', title: 'C', values: { id: 3, c1: 30, c2: null, Statut: 'Fait' } },
] as QueryRow[]

const q = (text: string): BaseQuery => {
  const p = parseBaseQuery(text)
  if ('error' in p) throw new Error(p.error)
  return p.query
}
const err = (text: string): string => {
  const p = parseBaseQuery(text)
  return 'error' in p ? p.error : ''
}
const cells = (text: string) => evaluateBaseQuery(q(text), ROWS, false).rows.map(r => r.cells)

describe('bloc de requete sur une base', () => {
  it('reconnait le bloc ```base', () => {
    expect(BASE_QUERY_FENCE_RE.test('```base\nfrom db.base\n```')).toBe(true)
    expect(BASE_QUERY_FENCE_RE.exec('```base\nfrom db.base\nselect count()\n```')?.[1]).toBe('from db.base\nselect count()')
  })

  it('agregats : sum, mean, min, max, median, count', () => {
    expect(cells('from db.base\nselect sum(prop("c1"))')).toEqual([[60]])
    expect(cells('from db.base\nselect sum(prop("c1")) as "Total", mean(prop("c1")), min(prop("c1")), max(prop("c1")), median(prop("c1")), count(), count(prop("c2"))'))
      .toEqual([[60, 20, 10, 30, 20, 3, 2]])
    expect(evaluateBaseQuery(q('from db.base\nselect sum(prop("c1")) as "Total"'), ROWS).columns).toEqual(['Total'])
    // Dates : min et max restent des dates.
    expect(cells('from db.base\nselect max(prop("Fin"))')).toEqual([['2026-03-01']])
    // Calcul autour des agregats.
    expect(cells('from db.base\nselect (2 * (sum(prop("c1")) + sum(prop("c2")))) / 2')).toEqual([[66]])
  })

  it('where : une formule par ligne, comme where id = 1', () => {
    expect(cells('from db.base\nwhere prop("id") == 1\nselect prop("c1")')).toEqual([[10]])
    expect(cells('from db.base\nwhere prop("Statut") == "Fait" and prop("c1") > 15\nselect sum(prop("c1")), count()')).toEqual([[30, 1]])
    expect(cells('from db.base\nwhere prop("Statut") == "Rien"\nselect sum(prop("c1")), count()')).toEqual([[0, 0]])
  })

  it('lignes : select par ligne, sort, limit ; sans select, le nom et les proprietes', () => {
    expect(cells('from db.base\nselect prop("Nom"), prop("c1") * 2\nsort prop("c1") desc\nlimit 2')).toEqual([['C', 60], ['B', 40]])
    const r = evaluateBaseQuery(q('from db.base\nsort prop("Nom")'), ROWS)
    expect(r.columns[0]).toBe('Nom')
    expect(r.rows.map(x => x.cells[0])).toEqual(['A', 'B', 'C'])
    expect(r.matched).toBe(3)
  })

  it('clauses sur plusieurs lignes, commentaires, erreurs claires', () => {
    expect(cells('// total\nfrom [[db.base]]\nselect sum(prop("c1")),\n  count()')).toEqual([[60, 3]])
    expect(err('select count()')).toMatch(/from/)
    expect(err('from db.base\ngroup x')).toMatch(/Ligne inconnue/)
    expect(err('from db.base\nwhere prop("x") ==')).toMatch(/^where/)
    expect(err('from db.base\nlimit -1')).toMatch(/limit/)
    expect(err('from db.base\nfrom autre.base')).toMatch(/deux fois/)
  })
})
