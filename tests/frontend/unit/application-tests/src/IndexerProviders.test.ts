// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Branchement du pair indexeur dans l'appli : bascule des requetes suivies
// quand le moteur prefere tombe ou revient, lecture de ses propres
// ecritures, recherche avec secours et recherche globale, pouvoirs.
import { describe, it, expect, vi } from 'vitest'
import { InMemoryQueryEngine } from '@savoire/plugin-runtime'
import type { IndexState, IQueryEngine, ISearchEngine, Query, QueryResult, SearchResult } from '@savoire/plugin-api'
import type { DocMetadata } from '@savoire/domain-index'
import {
  FullTextFallbackSearch, IndexerPowersProvider, QueryEngineProvider, SearchEngineProvider,
} from '@savoire/application'
import type { IIndexerSource, IVaultSyncSession, QueryVaultSources } from '@savoire/application'

const meta = (docId: string, path: string, frontmatter: Record<string, unknown>): DocMetadata => ({
  docId, path, crdtVersion: { clock: 0 }, title: '', tags: [], aliases: [], frontmatter,
})
const settle = () => new Promise(r => setTimeout(r, 120))

/** Un moteur prefere pilote a la main : etat, resultats, requetes suivies. */
function fakePreferred(rows: QueryResult['rows']) {
  let state: IndexState = { status: 'ready' }
  const stateCbs = new Set<(s: IndexState) => void>()
  const watchers = new Set<(r: QueryResult) => void>()
  const result = (): QueryResult => ({ rows, total: rows.length, index: state })
  const engine: IQueryEngine = {
    query: vi.fn(async () => result()),
    watch: vi.fn((_q: Query, cb: (r: QueryResult) => void) => {
      watchers.add(cb)
      queueMicrotask(() => cb(result()))
      return () => { watchers.delete(cb) }
    }),
    state: () => state,
    onStateChange: cb => { stateCbs.add(cb); return () => stateCbs.delete(cb) },
  }
  return {
    engine,
    watchers,
    setState(s: IndexState) { state = s; for (const cb of stateCbs) cb(s) },
    push() { for (const cb of watchers) cb(result()) },
  }
}

function vault(files: { id: string; path: string; fm?: Record<string, unknown> }[]) {
  const metas = new Map<string, DocMetadata>()
  for (const f of files) if (f.fm) metas.set(f.id, meta(f.id, f.path, f.fm))
  const metaCbs = new Set<(docId?: string) => void>()
  const session = {
    directory: { getAll: () => files.map(f => ({ id: f.id, path: f.path })), onChange: () => () => {}, getById: (id: string) => files.find(f => f.id === id) },
    readDocument: vi.fn(async () => ''),
  } as unknown as IVaultSyncSession
  const indexNow = vi.fn(async () => {})
  const sources: QueryVaultSources = {
    session,
    metadata: { getAll: () => [...metas.values()], onChange: cb => { metaCbs.add(cb); return () => metaCbs.delete(cb) } },
    indexNow,
  }
  /** La personne modifie une note ici : le canal metadata change, avec son id. */
  const editLocally = (id: string, fm: Record<string, unknown>) => {
    metas.set(id, meta(id, files.find(f => f.id === id)!.path, fm))
    for (const cb of metaCbs) cb(id)
  }
  return { sources, editLocally, indexNow }
}

describe('QueryEngineProvider et moteur prefere', () => {
  it('le prefere tombe : requetes suivies sur le moteur local, etat indisponible ; il revient : retour sur lui', async () => {
    const { sources } = vault([{ id: 'a', path: 'A.md', fm: { status: 'x' } }, { id: 'b', path: 'B.md' }])
    const provider = new QueryEngineProvider(() => new InMemoryQueryEngine())
    provider.attachVault(sources)
    const remote = fakePreferred([{ id: 'r', path: 'R.md', title: 'R', values: {} }])
    provider.setPreferred(remote.engine)
    const states: string[] = []
    provider.onStateChange(s => states.push(s.status))
    const seen: string[][] = []
    provider.watch({ from: { notes: true } }, r => seen.push(r.rows.map(x => x.id)))
    await settle()
    expect(seen.at(-1)).toEqual(['r'])
    remote.setState({ status: 'unavailable' })
    await settle()
    expect(provider.state().status).toBe('unavailable')
    expect(seen.at(-1)!.sort()).toEqual(['a', 'b'])
    expect(remote.watchers.size).toBe(0)
    // Pendant la panne, query() ne passe pas par le prefere.
    ;(remote.engine.query as ReturnType<typeof vi.fn>).mockClear()
    expect((await provider.query({ from: { notes: true } })).total).toBe(2)
    expect(remote.engine.query).not.toHaveBeenCalled()
    remote.setState({ status: 'ready' })
    await settle()
    expect(seen.at(-1)).toEqual(['r'])
    expect(states).toEqual(['unavailable', 'ready'])
  })

  it('lecture de ses propres ecritures : la ligne d une note modifiee ici prend ses valeurs locales, aussitot', async () => {
    const { sources, editLocally } = vault([{ id: 'a', path: 'A.md', fm: { status: 'todo' } }, { id: 'b', path: 'B.md', fm: { status: 'todo' } }])
    const provider = new QueryEngineProvider(() => new InMemoryQueryEngine())
    provider.attachVault(sources)
    await settle()
    // Le pair est en retard : il rend encore l'ancienne valeur.
    const remote = fakePreferred([
      { id: 'a', path: 'A.md', title: 'A', values: { status: 'todo' } },
      { id: 'b', path: 'B.md', title: 'B', values: { status: 'todo' } },
    ])
    const onLocalChange = vi.fn()
    provider.setPreferred(remote.engine, { readYourWrites: true, onLocalChange })
    const seen: QueryResult[] = []
    provider.watch({ from: { notes: true }, select: ['status'] }, r => seen.push(r))
    await settle()
    expect(seen.at(-1)!.rows.map(r => r.values.status)).toEqual(['todo', 'todo'])
    editLocally('a', { status: 'done' })
    await settle()
    expect(onLocalChange).toHaveBeenCalledWith('a')
    expect(seen.at(-1)!.rows.map(r => r.values.status)).toEqual(['done', 'todo'])
    // Un nouveau resultat du pair (toujours en retard) reste corrige.
    remote.push()
    expect(seen.at(-1)!.rows.map(r => r.values.status)).toEqual(['done', 'todo'])
    // query() aussi.
    expect((await provider.query({ from: { notes: true } })).rows[0].values.status).toBe('done')
  })

  it('sans lecture de ses ecritures (SQLite local) : les resultats du prefere tels quels', async () => {
    const { sources, editLocally } = vault([{ id: 'a', path: 'A.md', fm: { status: 'todo' } }])
    const provider = new QueryEngineProvider(() => new InMemoryQueryEngine())
    provider.attachVault(sources)
    await settle()
    const remote = fakePreferred([{ id: 'a', path: 'A.md', title: 'A', values: { status: 'todo' } }])
    provider.setPreferred(remote.engine)
    editLocally('a', { status: 'done' })
    await settle()
    expect((await provider.query({ from: { notes: true } })).rows[0].values.status).toBe('todo')
  })

  it('le prefere connait tout le vault : pas de rattrapage des notes jamais indexees', async () => {
    const { sources, indexNow } = vault([{ id: 'a', path: 'D/A.md' }, { id: 'b', path: 'D/B.md' }])
    const provider = new QueryEngineProvider(() => new InMemoryQueryEngine())
    provider.attachVault(sources)
    provider.setPreferred(fakePreferred([]).engine)
    await provider.query({ from: { notes: true, folder: 'D' } })
    await settle()
    expect(indexNow).not.toHaveBeenCalled()
  })
})

function searchResult(ids: string[], state: IndexState = { status: 'ready' }): SearchResult {
  return { hits: ids.map((id, i) => ({ id, path: `${id}.md`, title: id, score: 10 - i, snippets: [] })), total: ids.length, index: state }
}

describe('SearchEngineProvider', () => {
  it('le prefere repond ; indisponible : le secours, etat indisponible ; sans rien : refus', async () => {
    const provider = new SearchEngineProvider()
    await expect(provider.search({ text: 'x' })).rejects.toMatchObject({ code: 'unavailable' })
    let state: IndexState = { status: 'ready' }
    const cbs = new Set<(s: IndexState) => void>()
    const remote: ISearchEngine = {
      search: vi.fn(async () => searchResult(['r'])),
      state: () => state,
      onStateChange: cb => { cbs.add(cb); return () => cbs.delete(cb) },
    }
    const fallback: ISearchEngine = { search: vi.fn(async () => searchResult(['l'], { status: 'unavailable' })), state: () => ({ status: 'unavailable' }), onStateChange: () => () => {} }
    provider.setPreferred(remote)
    provider.setFallback(fallback)
    const states: string[] = []
    provider.onStateChange(s => states.push(s.status))
    expect((await provider.search({ text: 'x' })).hits[0].id).toBe('r')
    // Le pair refuse en cours de route : secours.
    ;(remote.search as ReturnType<typeof vi.fn>).mockRejectedValueOnce(Object.assign(new Error('x'), { code: 'unavailable' }))
    expect((await provider.search({ text: 'x' })).hits[0].id).toBe('l')
    // Une recherche refusee (parametres) n'est pas rattrapee.
    ;(remote.search as ReturnType<typeof vi.fn>).mockRejectedValueOnce(Object.assign(new Error('x'), { code: 'invalid_cursor' }))
    await expect(provider.search({ text: 'x', cursor: 'zz' })).rejects.toMatchObject({ code: 'invalid_cursor' })
    // Pair indisponible : le secours sans essayer le pair.
    state = { status: 'unavailable' }
    for (const cb of cbs) cb(state)
    ;(remote.search as ReturnType<typeof vi.fn>).mockClear()
    expect((await provider.search({ text: 'x' })).hits[0].id).toBe('l')
    expect(remote.search).not.toHaveBeenCalled()
    expect(provider.state().status).toBe('unavailable')
    expect(states).toEqual(['unavailable'])
  })

  it('recherche globale : seulement avec une source et un hote ; noms des vaults ; ouverture par l hote', async () => {
    const provider = new SearchEngineProvider()
    expect(provider.global).toBeUndefined()
    provider.setGlobalSource({ searchAll: async () => ({ ...searchResult(['n1', 'n2']), hits: [
      { id: 'n1', path: 'A.md', title: 'A', score: 2, snippets: [], vaultId: 'v1' },
      { id: 'n2', path: 'B.md', title: 'B', score: 1, snippets: [], vaultId: 'v2' },
    ], partial: true }) })
    expect(provider.global).toBeUndefined()
    const open = vi.fn(async () => {})
    provider.setGlobalHost({ vaultName: id => (id === 'v1' ? 'Perso' : undefined), open })
    const r = await provider.global!.search({ text: 'x' })
    expect(r.hits.map(h => h.vaultName)).toEqual(['Perso', undefined])
    expect(r.partial).toBe(true)
    await provider.global!.open(r.hits[1])
    expect(open).toHaveBeenCalledWith('v2', 'B.md')
  })
})

describe('FullTextFallbackSearch (MiniSearch, notes ouvertes)', () => {
  const index = {
    search: (text: string) => text === 'vol'
      ? [
        { docId: 'a', path: 'Géo/Volcan.md', score: 3, terms: ['volcan'] },
        { docId: 'b', path: 'Géo/Lave.md', score: 2, terms: ['volcanique'] },
        { docId: 't', path: '.trash/Vieux.md', score: 5, terms: ['volcan'] },
        { docId: 'c', path: 'Notes/Éruption volcanique.md', score: 1, terms: ['volcanique'] },
      ]
      : [],
  }
  const engine = new FullTextFallbackSearch({ index: () => index, isTrashed: id => id === 't' })

  it('resultats sans la corbeille, titres surlignes, etat du mode degrade', async () => {
    const r = await engine.search({ text: 'vol' })
    expect(r.hits.map(h => h.id)).toEqual(['a', 'b', 'c'])
    expect(r.index.status).toBe('unavailable')
    expect(r.hits[0].titleHighlights).toEqual([{ start: 0, end: 6 }])
    expect(r.hits[2].title).toBe('Éruption volcanique')
    expect(r.hits[2].titleHighlights).toEqual([{ start: 9, end: 19 }])
    expect(engine.state().status).toBe('unavailable')
  })

  it('pagination, dossier, curseur d une autre recherche, filtre refuse', async () => {
    const p1 = await engine.search({ text: 'vol', limit: 2 })
    expect(p1.hits.map(h => h.id)).toEqual(['a', 'b'])
    const p2 = await engine.search({ text: 'vol', limit: 2, cursor: p1.next })
    expect(p2.hits.map(h => h.id)).toEqual(['c'])
    expect(p2.next).toBeUndefined()
    expect((await engine.search({ text: 'vol', folder: 'Notes' })).hits.map(h => h.id)).toEqual(['c'])
    await expect(engine.search({ text: 'autre', cursor: p1.next })).rejects.toMatchObject({ code: 'invalid_cursor' })
    await expect(engine.search({ text: 'vol', where: { field: { prop: 'x' }, op: 'eq', value: 1 } })).rejects.toMatchObject({ code: 'unavailable' })
  })
})

describe('IndexerPowersProvider (api.indexer)', () => {
  it('sans source : indisponible, appels refuses ; avec source : relaye ; etat suivi', async () => {
    const powers = new IndexerPowersProvider()
    expect(powers.available()).toBe(false)
    await expect(powers.links.backlinks({ id: 'a' })).rejects.toMatchObject({ code: 'unavailable' })
    let state: IndexState = { status: 'building', progress: 0.5 }
    const cbs = new Set<(s: IndexState) => void>()
    const source: IIndexerSource = {
      call: vi.fn(async (cap: string, method: string) => ({ items: [{ id: 'x', path: 'X.md', title: 'X', count: 1, cap, method }] })),
      state: () => state,
      onStateChange: cb => { cbs.add(cb); return () => cbs.delete(cb) },
    }
    const states: IndexState[] = []
    powers.onStateChange(s => states.push(s))
    powers.setSource(source)
    expect(powers.available()).toBe(true)
    const r = await powers.links.backlinks({ id: 'a', limit: 10 })
    expect(r.items[0].id).toBe('x')
    expect(source.call).toHaveBeenCalledWith('links', 'backlinks', { id: 'a', limit: 10 }, undefined)
    await powers.tags.list()
    expect(source.call).toHaveBeenLastCalledWith('tags', 'list', {}, undefined)
    state = { status: 'unavailable' }
    for (const cb of cbs) cb(state)
    expect(powers.available()).toBe(false)
    powers.setSource(null)
    expect(states.map(s => s.status)).toEqual(['building', 'unavailable', 'unavailable'])
  })
})
