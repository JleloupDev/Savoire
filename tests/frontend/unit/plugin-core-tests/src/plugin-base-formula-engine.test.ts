// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// plugin-base : filtres, tris et groupes sur des colonnes formules, calcules
// dans le client autour du moteur de requetes.
import { describe, it, expect } from 'vitest'
import { InMemoryQueryEngine } from '@savoire/plugin-runtime'
import { compileFormula } from '@savoire/plugin-api'
import type { CompiledFormula, Query, QueryResult } from '@savoire/plugin-api'
import { withFormulas, needsFormulas, splitWhere } from '@savoire/plugin-base'

function setup() {
  const inner = new InMemoryQueryEngine()
  inner.upsertMany([
    { id: 'a', path: 'db/A.md', title: 'A', props: { prix: 10, qte: 3, statut: 'Fait' } },
    { id: 'b', path: 'db/B.md', title: 'B', props: { prix: 4, qte: 10, statut: 'En cours' } },
    { id: 'c', path: 'db/C.md', title: 'C', props: { prix: 7, qte: 1, statut: 'Fait' } },
    { id: 'z', path: 'autre/Z.md', title: 'Z', props: { prix: 99, qte: 99 } },
  ])
  const formulas: Record<string, CompiledFormula> = {
    '=Total': compileFormula('prop("prix") * prop("qte")'),
    '=Cher': compileFormula('prop("prix") > 5'),
  }
  const engine = withFormulas(inner, k => formulas[k])
  return { inner, engine, formulas }
}
const from = { notes: true as const, folder: 'db' }
const titles = (r: QueryResult) => r.rows.map(x => x.title)

describe('formules dans les filtres et les tris', () => {
  it('repere les requetes qui parlent de formules et coupe le filtre', () => {
    expect(needsFormulas({ from })).toBe(false)
    expect(needsFormulas({ from, sort: [{ field: { prop: '=Total' } }] })).toBe(true)
    const w = { and: [{ field: { prop: 'statut' }, op: 'eq' as const, value: 'Fait' }, { field: { prop: '=Total' }, op: 'gt' as const, value: 10 }] }
    expect(splitWhere(w)).toEqual({ engine: w.and[0], client: w.and[1] })
    const or = { or: w.and }
    expect(splitWhere(or)).toEqual({ client: or })
  })

  it('filtre sur une formule, avec un filtre ordinaire en plus', async () => {
    const { engine } = setup()
    const r = await engine.query({ from, where: { field: { prop: '=Total' }, op: 'gt', value: 10 }, sort: [{ field: { doc: 'title' } }] })
    expect(titles(r)).toEqual(['A', 'B'])
    expect(r.total).toBe(2)
    // La valeur saisie en texte se compare en nombre.
    const both = await engine.query({ from, where: { and: [{ field: { prop: 'statut' }, op: 'eq', value: 'Fait' }, { field: { prop: '=Total' }, op: 'gte', value: '7' }] } })
    expect(titles(both).sort()).toEqual(['A', 'C'])
    const bool = await engine.query({ from, where: { field: { prop: '=Cher' }, op: 'eq', value: true } })
    expect(titles(bool).sort()).toEqual(['A', 'C'])
  })

  it('trie sur une formule, pagine par curseur et compte les groupes', async () => {
    const { engine } = setup()
    const q: Query = { from, sort: [{ field: { prop: '=Total' }, dir: 'desc' }], limit: 2 }
    const p1 = await engine.query(q)
    expect(titles(p1)).toEqual(['B', 'A'])
    expect(p1.total).toBe(3)
    const p2 = await engine.query({ ...q, cursor: p1.next })
    expect(titles(p2)).toEqual(['C'])
    expect(p2.next).toBeUndefined()
    const g = await engine.query({ from, where: { field: { prop: '=Cher' }, op: 'eq', value: true }, groupBy: { prop: 'statut' }, limit: 1 })
    expect(g.groups).toEqual([{ key: 'Fait', count: 2 }])
  })

  it('suit les changements en direct ; sans formule, le moteur repond seul', async () => {
    const { inner, engine } = setup()
    const seen: string[][] = []
    const stop = engine.watch({ from, where: { field: { prop: '=Total' }, op: 'gt', value: 10 }, sort: [{ field: { doc: 'title' } }] }, r => seen.push(titles(r)))
    await new Promise(r => setTimeout(r, 120))
    inner.upsert({ id: 'c', path: 'db/C.md', title: 'C', props: { prix: 7, qte: 5, statut: 'Fait' } })
    await new Promise(r => setTimeout(r, 120))
    stop()
    expect(seen.at(-1)).toEqual(['A', 'B', 'C'])
    const plain = await engine.query({ from, sort: [{ field: { prop: 'prix' } }] })
    expect(titles(plain)).toEqual(['B', 'C', 'A'])
  })
})
