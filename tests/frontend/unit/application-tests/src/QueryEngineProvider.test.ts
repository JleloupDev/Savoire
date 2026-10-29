// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// api.query dans l'appli : le fournisseur de moteur de requetes, alimente par
// le canal d'index 'metadata', l'arborescence, les types du vault et les lots
// de lignes legeres des bases.
import { describe, it, expect, vi } from 'vitest'
import { InMemoryQueryEngine, InMemorySharedTree } from '@savoire/plugin-runtime'
import { BASE_ROW_PREFIX, baseLotName, baseLotOf } from '@savoire/plugin-api'
import type { IQueryEngine, ITreeMap, QueryResult } from '@savoire/plugin-api'
import type { DocMetadata } from '@savoire/domain-index'
import { QueryEngineProvider, VaultPropertyTypes, annexDocId } from '@savoire/application'
import type { ITreeSource, IVaultSyncSession, QueryVaultSources } from '@savoire/application'
import { MemChannel } from './helpers/memChannel'

const meta = (docId: string, path: string, frontmatter: Record<string, unknown>): DocMetadata => ({
  docId, path, crdtVersion: { clock: 0 }, title: '', tags: [], aliases: [], frontmatter,
})

function setup(files: { id: string; path: string; text?: string; fm?: Record<string, unknown> }[]) {
  const dir = files.map(f => ({ id: f.id, path: f.path }))
  const dirCbs = new Set<() => void>()
  const metas = new Map<string, DocMetadata>()
  for (const f of files) if (f.fm) metas.set(f.id, meta(f.id, f.path, f.fm))
  const metaCbs = new Set<() => void>()
  const settings = new MemChannel()
  const session = {
    directory: { getAll: () => dir, onChange: (cb: () => void) => { dirCbs.add(cb); return () => dirCbs.delete(cb) } },
    readDocument: vi.fn(async (id: string) => files.find(f => f.id === id)?.text ?? ''),
    openVaultSettings: () => settings,
  } as unknown as IVaultSyncSession
  const types = new VaultPropertyTypes()
  types.attachVault(session)
  const trees = new Map<string, InMemorySharedTree>()
  const treeOf = (id: string) => { let t = trees.get(id); if (!t) { t = new InMemorySharedTree(); trees.set(id, t) } return t }
  const treeSource: ITreeSource = {
    open: async id => treeOf(id),
    close: vi.fn(),
    openAnnex: async (id, name) => treeOf(annexDocId(id, name)),
    closeAnnex: vi.fn(),
  }
  const indexNow = vi.fn(async (docId: string, path: string, markdown: string) => {
    const status = /status: (.*)/.exec(markdown)?.[1]
    metas.set(docId, meta(docId, path, status ? { status } : {}))
    for (const cb of metaCbs) cb()
  })
  const sources: QueryVaultSources = {
    session,
    metadata: { getAll: () => [...metas.values()], onChange: cb => { metaCbs.add(cb); return () => metaCbs.delete(cb) } },
    types,
    indexNow,
    trees: treeSource,
  }
  const provider = new QueryEngineProvider(() => new InMemoryQueryEngine())
  provider.attachVault(sources)
  const publish = (id: string, fm: Record<string, unknown>) => {
    metas.set(id, meta(id, dir.find(d => d.id === id)!.path, fm))
    for (const cb of metaCbs) cb()
  }
  const move = (id: string, path: string) => {
    dir.find(d => d.id === id)!.path = path
    for (const cb of dirCbs) cb()
  }
  return { provider, types, publish, move, treeOf, indexNow, settle: () => new Promise(r => setTimeout(r, 40)) }
}

const ids = (r: QueryResult) => r.rows.map(x => x.id)

describe('QueryEngineProvider', () => {
  it('les notes du canal metadata, typees par le schema du vault ; corbeille et pieces jointes exclues', async () => {
    const { provider, types } = setup([
      { id: 'a', path: 'Projets/Alpha.md', fm: { priority: '2', done: 'true', tags: ['x'], due: '2026-11-03' } },
      { id: 'b', path: 'Projets/Beta.md', fm: { priority: '10' } },
      { id: 't', path: '.trash/Vieux.md', fm: { priority: '1' } },
      { id: 'i', path: 'Projets/schema.png' },
    ])
    // Sans type declare, '10' reste du texte : '10' < '2'.
    let r = await provider.query({ from: { notes: true }, sort: [{ field: { prop: 'priority' } }] })
    expect(ids(r)).toEqual(['b', 'a'])
    types.set({ key: 'priority', type: 'number' })
    types.set({ key: 'done', type: 'checkbox' })
    await new Promise(res => setTimeout(res, 40))
    r = await provider.query({ from: { notes: true }, sort: [{ field: { prop: 'priority' } }] })
    expect(ids(r)).toEqual(['a', 'b'])
    expect(r.rows[0]).toMatchObject({ title: 'Alpha', path: 'Projets/Alpha.md', values: { priority: 2, done: true, tags: ['x'], due: '2026-11-03' } })
  })

  it('suit les changements du canal et de l arborescence (watch)', async () => {
    const { provider, publish, move, settle } = setup([
      { id: 'a', path: 'P/A.md', fm: { status: 'En cours' } },
      { id: 'b', path: 'P/B.md', fm: { status: 'Fait' } },
    ])
    const seen: number[] = []
    const stop = provider.watch({ from: { notes: true, folder: 'P' }, where: { field: { prop: 'status' }, op: 'eq', value: 'en cours' } }, r => seen.push(r.total))
    publish('b', { status: 'en cours' })
    await settle()
    move('a', 'Ailleurs/A.md')
    await settle()
    stop()
    expect(seen[0]).toBe(1)
    expect(seen).toContain(2)
    expect(seen.at(-1)).toBe(1)
  })

  it('rattrape les notes jamais indexees d un dossier interroge, avec un etat en construction', async () => {
    const { provider, indexNow } = setup([
      { id: 'a', path: 'P/A.md', text: '---\nstatus: Fait\n---\n' },
      { id: 'b', path: 'P/B.md', text: '---\nstatus: En cours\n---\n' },
      { id: 'c', path: 'Autre/C.md', text: '---\nstatus: En cours\n---\n' },
    ])
    const states: string[] = []
    provider.onStateChange(s => states.push(s.status + (s.progress !== undefined ? `:${Math.round(s.progress * 100)}` : '')))
    const first = await provider.query({ from: { notes: true, folder: 'P' } })
    expect(first.index.status).toBe('building')
    await provider.whenIdle()
    await new Promise(r => setTimeout(r, 40))
    const r = await provider.query({ from: { notes: true, folder: 'P' }, where: { field: { prop: 'status' }, op: 'eq', value: 'fait' } })
    expect(ids(r)).toEqual(['a'])
    expect(indexNow).toHaveBeenCalledTimes(2) // pas la note hors du dossier
    expect(states).toContain('building:50')
    expect(states.at(-1)).toBe('ready')
    expect(provider.state().status).toBe('ready')
  })

  it('lignes legeres : lit les lots de la base et suit leurs changements', async () => {
    const { provider, treeOf } = setup([{ id: 'n', path: 'Base/Page.md', fm: { status: 'Fait' } }])
    // Manifeste de la base et deux lignes, dans leurs lots.
    const base = treeOf('base1')
    const rowIds = ['r1', 'r2']
    const lots = [...new Set(rowIds.map(id => baseLotOf(id)))]
    base.root.set('base', { kind: 'map', entries: { lotCount: 64, lots: { kind: 'map', entries: Object.fromEntries(lots.map(n => [String(n), true])) } } })
    for (const id of rowIds) {
      treeOf(annexDocId('base1', baseLotName(baseLotOf(id)))).root.set(BASE_ROW_PREFIX + id, {
        kind: 'map', entries: { title: `Ligne ${id}`, status: id === 'r1' ? 'En cours' : 'Fait', tags: { kind: 'list', items: ['a'] } },
      })
    }
    const seen: number[] = []
    const stop = provider.watch({ from: { base: 'base1', pages: { folder: 'Base' } }, where: { field: { prop: 'status' }, op: 'eq', value: 'fait' } }, r => seen.push(r.total))
    await provider.whenIdle()
    const r = await provider.query({ from: { base: 'base1' }, sort: [{ field: { doc: 'title' } }] })
    expect(r.rows).toMatchObject([
      { id: 'r1', path: '', title: 'Ligne r1', values: { status: 'En cours', tags: ['a'] } },
      { id: 'r2', path: '', title: 'Ligne r2', values: { status: 'Fait' } },
    ])
    // Une cellule change dans un lot : seule la ligne est relue.
    const lot1 = treeOf(annexDocId('base1', baseLotName(baseLotOf('r1'))))
    ;(lot1.root.get(BASE_ROW_PREFIX + 'r1') as ITreeMap).set('status', 'Fait')
    expect(seen.at(-1)).toBe(3)
    // Un nouveau lot apparait dans le manifeste : il est ouvert a son tour.
    const n3 = baseLotOf('r3')
    treeOf(annexDocId('base1', baseLotName(n3))).root.set(BASE_ROW_PREFIX + 'r3', { kind: 'map', entries: { title: 'Trois', status: 'Fait' } })
    ;((base.root.get('base') as ITreeMap).get('lots') as ITreeMap).set(String(n3), true)
    await provider.whenIdle()
    await new Promise(res => setTimeout(res, 0))
    expect(seen.at(-1)).toBe(4)
    // Suppression d'une ligne.
    lot1.root.delete(BASE_ROW_PREFIX + 'r1')
    expect(seen.at(-1)).toBe(3)
    stop()
  })

  it('un moteur prefere repond d abord ; indisponible, le moteur local reprend', async () => {
    const { provider } = setup([{ id: 'a', path: 'A.md', fm: {} }])
    const remote: IQueryEngine = {
      query: vi.fn(async () => { throw Object.assign(new Error('pair indisponible'), { code: 'unavailable' }) }),
      watch: vi.fn(() => () => {}),
      state: () => ({ status: 'ready' as const }),
      onStateChange: () => () => {},
    }
    provider.setPreferred(remote)
    const r = await provider.query({ from: { notes: true } })
    expect(remote.query).toHaveBeenCalled()
    expect(ids(r)).toEqual(['a'])
    const refused: IQueryEngine = { ...remote, query: vi.fn(async () => { throw Object.assign(new Error('x'), { code: 'invalid_query' }) }) }
    provider.setPreferred(refused)
    await expect(provider.query({ from: { notes: true } })).rejects.toMatchObject({ code: 'invalid_query' })
  })
})
