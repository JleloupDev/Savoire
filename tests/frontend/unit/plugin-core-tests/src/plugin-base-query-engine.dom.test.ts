// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// plugin-base : le bloc ```base calcule ses agregats par le moteur de
// requetes quand il le peut (sans lire les lignes, sans plafond), et la
// traduction des formules qui le permet.
import { describe, it, expect, vi } from 'vitest'
import { InMemoryQueryEngine } from '@savoire/plugin-runtime'
import { compileFormula, aggregateKey } from '@savoire/plugin-api'
import type { IQueryEngine, PluginAPI } from '@savoire/plugin-api'
import { enginePlan, parseBaseQuery, renderBaseQueryBlock } from '@savoire/plugin-base'

const plan = (text: string) => {
  const p = parseBaseQuery(text)
  if ('error' in p) throw new Error(p.error)
  return enginePlan(p.query)
}

describe('formules traduites pour le moteur', () => {
  it('agregats simples, ou rien', () => {
    expect(compileFormula('sum(prop("a")) / count()').aggregateCalls).toEqual([{ fn: 'sum', prop: 'a' }, { fn: 'count' }])
    expect(compileFormula('median(prop("a"))').aggregateCalls).toBeNull()
    expect(compileFormula('sum(prop("a") * 2)').aggregateCalls).toBeNull()
    expect(compileFormula('sum(prop("a")) + prop("b")').aggregateCalls).toBeNull()
    expect(compileFormula('1 + 1').aggregateCalls).toBeNull()
    const f = compileFormula('(2 * (sum(prop("a")) + sum(prop("b")))) / 2')
    const values = new Map([[aggregateKey({ fn: 'sum', prop: 'a' }), 20], [aggregateKey({ fn: 'sum', prop: 'b' }), 10]])
    expect(f.evaluateAggregates(values)).toEqual({ ok: true, value: 30 })
  })

  it('where : nombres, booleens, empty, and / or / not ; les textes restent cote client', () => {
    expect(compileFormula('prop("id") == 1').toFilter()).toEqual({ field: { prop: 'id' }, op: 'eq', value: 1 })
    // Une valeur vide vaut 0 : elle passe « < 5 », pas « > 5 ».
    expect(compileFormula('5 > prop("x")').toFilter()).toEqual({ or: [{ field: { prop: 'x' }, op: 'empty' }, { field: { prop: 'x' }, op: 'lt', value: 5 }] })
    expect(compileFormula('prop("x") > 5 and not(empty(prop("y")))').toFilter()).toEqual({
      and: [{ field: { prop: 'x' }, op: 'gt', value: 5 }, { not: { field: { prop: 'y' }, op: 'empty' } }],
    })
    expect(compileFormula('prop("ok") == true or prop("Nom") != 3').toFilter()).toEqual({
      or: [{ field: { prop: 'ok' }, op: 'eq', value: true }, { or: [{ field: { doc: 'title' }, op: 'empty' }, { field: { doc: 'title' }, op: 'neq', value: 3 }] }],
    })
    expect(compileFormula('prop("s") == "Fait"').toFilter()).toBeNull()
    expect(compileFormula('prop("a") > prop("b")').toFilter()).toBeNull()
  })

  it('plan du bloc', () => {
    expect(plan('from db\nselect sum(prop("c1")), count()')).toMatchObject({ aggregate: [{ op: 'sum', field: { prop: 'c1' } }, { op: 'count' }] })
    expect(plan('from db\nwhere prop("id") > 2\nselect max(prop("Nom"))')).toMatchObject({ where: { field: { prop: 'id' }, op: 'gt', value: 2 }, aggregate: [{ op: 'max', field: { doc: 'title' } }] })
    expect(plan('from db\nwhere prop("s") == "Fait"\nselect sum(prop("c1"))')).toBeNull()
    expect(plan('from db\nselect prop("c1")')).toBeNull()
  })
})

describe('bloc de requete sur une grande base', () => {
  it('25 000 lignes : agregats exacts, sans lire les lignes, suivis en direct', async () => {
    const inner = new InMemoryQueryEngine()
    inner.upsertMany(Array.from({ length: 25_000 }, (_, i) => ({ id: `d${i}`, path: `Big/N${i}.md`, title: `N${i}`, props: { n: i % 10, ok: i % 2 === 0 } })))
    const query = vi.fn((q, o) => inner.query(q, o))
    const engine: IQueryEngine = { query, watch: (q, cb) => inner.watch(q, cb), state: () => inner.state(), onStateChange: cb => inner.onStateChange(cb) }
    const api = {
      query: engine,
      vault: { resolveDocumentId: (p: string) => p === 'Big.base' ? 'B' : undefined, list: async () => ['Big.base'] },
      workspace: { openFile: async () => {} },
    } as unknown as PluginAPI
    const el = renderBaseQueryBlock('from Big\nwhere prop("ok") == true\nselect sum(prop("n")) as "Total", count() as "Lignes"', api)
    document.body.appendChild(el)
    await new Promise(r => setTimeout(r, 100))
    const cells = () => Array.from(el.querySelectorAll('td')).map(td => td.textContent)
    // Pairs : n vaut 0, 2, 4, 6, 8 ; 2 500 fois chacun.
    expect(cells()).toEqual(['50 000', '12 500'])
    expect(el.textContent).not.toContain('limité')
    expect(query).not.toHaveBeenCalled()
    inner.upsert({ id: 'd0', path: 'Big/N0.md', title: 'N0', props: { n: 100, ok: true } })
    await new Promise(r => setTimeout(r, 50))
    expect(cells()[0]).toBe('50 100')
    el.dispatchEvent(new CustomEvent('savoire:block-destroy'))
  })
})
