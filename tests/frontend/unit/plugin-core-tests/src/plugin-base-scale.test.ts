// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Banc d'essai des lignes legeres (ADR-027, etape 7) : une base de 100 000
// lignes en memoire, dans 64 lots, chez deux membres relies
// (InMemorySharedTree.link). On mesure le chargement d'un lot dans l'index,
// celui de toute la base, une cellule modifiee chez A vue dans l'index de B,
// et une requete filtree triee. Les chiffres sont imprimes ; les bornes des
// assertions sont larges (machines lentes).
import { describe, it, expect } from 'vitest'
import { InMemoryQueryEngine, InMemorySharedTree } from '@savoire/plugin-runtime'
import { QueryEngineProvider, annexDocId } from '@savoire/application'
import type { IVaultSyncSession, QueryVaultSources } from '@savoire/application'
import { BASE_LOT_COUNT, BASE_ROW_PREFIX, baseLotName, baseLotOf } from '@savoire/plugin-api'
import type { Query, QueryResult, TreeValueInit } from '@savoire/plugin-api'
import { LightRows, ManifestStore, defaultManifest } from '@savoire/plugin-base'

const ROWS = 100_000
const STATUS = ['À faire', 'En cours', 'Fait', 'Bloqué', 'Abandonné']

function pairOf(map: Map<string, [InMemorySharedTree, InMemorySharedTree]>, id: string) {
  let p = map.get(id)
  if (!p) { p = [new InMemorySharedTree(), new InMemorySharedTree()]; InMemorySharedTree.link(p[0], p[1]); map.set(id, p) }
  return p
}

function provider(trees: Map<string, [InMemorySharedTree, InMemorySharedTree]>, peer: 0 | 1, manifestId = 'base') {
  const session = {
    directory: { getAll: () => [], onChange: () => () => {} },
    readDocument: async () => '',
  } as unknown as IVaultSyncSession
  const sources: QueryVaultSources = {
    session,
    metadata: { getAll: () => [], onChange: () => () => {} },
    trees: {
      open: async () => pairOf(trees, manifestId)[peer],
      close: () => {},
      openAnnex: async (_id, name) => pairOf(trees, annexDocId('base', name))[peer],
      closeAnnex: () => {},
    },
  }
  const p = new QueryEngineProvider(() => new InMemoryQueryEngine())
  p.attachVault(sources)
  return p
}

const ms = (t0: number) => Math.round((performance.now() - t0) * 10) / 10

describe('lignes legeres a l echelle (100 000 lignes, deux membres)', () => {
  it('charge, synchronise et interroge une base de 100 000 lignes', async () => {
    const trees = new Map<string, [InMemorySharedTree, InMemorySharedTree]>()
    const timings: Record<string, number | string> = {}

    // ── Generation chez A, un lot = une transaction, rejouee chez B ─────────
    let t0 = performance.now()
    const byLot = new Map<number, Record<string, TreeValueInit>>()
    for (let i = 0; i < ROWS; i++) {
      const id = `r${i.toString(36)}`
      const n = baseLotOf(id)
      let entries = byLot.get(n)
      if (!entries) { entries = {}; byLot.set(n, entries) }
      entries[BASE_ROW_PREFIX + id] = {
        kind: 'map',
        entries: {
          title: `Ligne ${i}`,
          status: STATUS[i % STATUS.length],
          priority: i % 1000,
          tags: { kind: 'list', items: i % 7 === 0 ? ['urgent', 'client'] : ['client'] },
        },
      }
    }
    for (const [n, entries] of byLot) {
      const a = pairOf(trees, annexDocId('base', baseLotName(n)))[0]
      a.transact(() => { for (const [k, v] of Object.entries(entries)) a.root.set(k, v) })
    }
    const manifestA = pairOf(trees, 'base')[0]
    manifestA.root.set('base', {
      kind: 'map',
      entries: { lotCount: BASE_LOT_COUNT, lots: { kind: 'map', entries: Object.fromEntries([...byLot.keys()].map(n => [String(n), true])) } },
    })
    timings['generation chez A + replication chez B (100 000 lignes, 64 lots)'] = ms(t0)
    const sizes = [...byLot.values()].map(e => Object.keys(e).length)
    timings['lignes par lot (min / max)'] = `${Math.min(...sizes)} / ${Math.max(...sizes)}`
    expect(byLot.size).toBe(BASE_LOT_COUNT)

    // ── Un lot seul dans l'index de B ────────────────────────────────────────
    const single = pairOf(trees, 'base-un-lot')
    single[0].root.set('base', { kind: 'map', entries: { lotCount: BASE_LOT_COUNT, lots: { kind: 'map', entries: { '0': true } } } })
    const one = provider(trees, 1, 'base-un-lot')
    t0 = performance.now()
    await one.query({ from: { base: 'base' }, limit: 1 })
    await one.whenIdle()
    timings[`chargement d'un lot dans l'index (${byLot.get(0) ? Object.keys(byLot.get(0)!).length : 0} lignes)`] = ms(t0)
    expect((await one.query({ from: { base: 'base' }, limit: 1 })).total).toBe(Object.keys(byLot.get(0)!).length)
    one.dispose()

    // ── Toute la base dans l'index de B ──────────────────────────────────────
    const b = provider(trees, 1)
    t0 = performance.now()
    await b.query({ from: { base: 'base' }, limit: 1 })
    await b.whenIdle()
    timings['chargement des 64 lots dans l\'index (100 000 lignes)'] = ms(t0)
    expect((await b.query({ from: { base: 'base' }, limit: 1 })).total).toBe(ROWS)

    // ── Requete filtree triee ────────────────────────────────────────────────
    const q: Query = {
      from: { base: 'base' },
      where: { and: [{ field: { prop: 'status' }, op: 'eq', value: 'en cours' }, { field: { prop: 'priority' }, op: 'gte', value: 500 }] },
      sort: [{ field: { prop: 'priority' }, dir: 'desc' }, { field: { doc: 'title' } }],
      limit: 50,
    }
    const runs: number[] = []
    let result!: QueryResult
    for (let i = 0; i < 5; i++) {
      t0 = performance.now()
      result = await b.query(q)
      runs.push(ms(t0))
    }
    runs.sort((x, y) => x - y)
    timings['requete filtree triee sur 100 000 lignes (mediane de 5)'] = runs[2]
    expect(result.total).toBe(10_000)
    // 'En cours' : i = 1 (mod 5), donc priorite = 1 (mod 5) : 996 au plus.
    expect(result.rows[0].values.priority).toBe(996)
    const sortOnly = performance.now()
    await b.query({ from: { base: 'base' }, sort: [{ field: { doc: 'title' } }], limit: 50 })
    timings['tri de 100 000 lignes par titre (texte replie)'] = ms(sortOnly)

    // ── Une cellule modifiee chez A, vue dans l'index de B ───────────────────
    const store = new ManifestStore(manifestA, () => defaultManifest(''))
    const rowsA = new LightRows({
      openMap: () => { throw new Error('inutile') },
      openTree: async name => pairOf(trees, annexDocId('base', name))[0],
    }, store, () => BASE_LOT_COUNT)
    const target = 'r' + (1).toString(36) // Ligne 1 : En cours, priorite 1
    let seenAt = 0
    const stop = b.watch({ ...q, where: { field: { prop: 'status' }, op: 'eq', value: 'modifiee' } }, r => {
      if (r.total === 1 && !seenAt) seenAt = performance.now()
    })
    t0 = performance.now()
    await rowsA.setCell(target, 'status', 'modifiee')
    stop()
    expect(seenAt).toBeGreaterThan(0)
    timings['cellule modifiee chez A -> resultat a jour chez B (requete suivie)'] = Math.round((seenAt - t0) * 10) / 10
    // Une modification ne touche qu'un lot.
    const touched = [...trees.entries()].filter(([id]) => id.startsWith('base~')).filter(([, [tA]]) => tA.root.has(BASE_ROW_PREFIX + target)).length
    expect(touched).toBe(1)

    // Chiffres du rapport.
    console.log('\n[base 100 000 lignes] mesures (ms) :')
    for (const [k, v] of Object.entries(timings)) console.log(`  - ${k} : ${v}`)
    expect(runs[2]).toBeLessThan(5000)
    b.dispose()
  }, 180_000)
})
