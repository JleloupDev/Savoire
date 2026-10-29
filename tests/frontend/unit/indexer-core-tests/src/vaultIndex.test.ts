// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// API du noyau : appels du protocole (capacite.methode) et leurs erreurs,
// etat de l'index, sequence, deplacements, corbeille, transaction tout ou
// rien, pouvoir ajoute, requetes hostiles.
import { describe, it, expect, vi } from 'vitest'
import { VaultIndex, defaultPowers, makeRecord, method, sql } from '@savoire/indexer-core'
import type { IndexPower } from '@savoire/indexer-core'
import { NodeSqliteDriver } from '@savoire/indexer-core/node'
import { memoryIndex } from './helpers'

const all = { from: { notes: true as const } }

describe('appels du protocole', () => {
  it('pouvoir ou methode inconnus ; parametres verifies', async () => {
    const index = await memoryIndex()
    await expect(index.call('rien', 'run', {})).rejects.toMatchObject({ code: 'unknown_capability' })
    await expect(index.call('query', 'toString', {})).rejects.toMatchObject({ code: 'unknown_method' })
    await expect(index.call('query', 'run', { from: { notes: true }, limit: '10' })).rejects.toMatchObject({ code: 'invalid_query' })
    await expect(index.call('query', 'run', { from: { notes: true }, where: { field: { doc: 'secret' }, op: 'eq', value: 1 } })).rejects.toMatchObject({ code: 'invalid_query' })
    await expect(index.call('query', 'run', { from: { notes: true }, where: { field: { prop: 'a' }, op: 'like', value: 1 } })).rejects.toMatchObject({ code: 'invalid_query' })
    await expect(index.call('query', 'run', { from: { notes: true }, sort: Array(9).fill({ field: { doc: 'path' } }) })).rejects.toMatchObject({ code: 'too_complex' })
    await expect(index.call('query', 'run', 'SELECT 1')).rejects.toMatchObject({ code: 'invalid_query' })
    await expect(index.call('links', 'backlinks', {})).rejects.toMatchObject({ code: 'invalid_query' })
    await expect(index.call('links', 'graph', { limit: 1e9 })).rejects.toMatchObject({ code: 'invalid_query' })
    await expect(index.call('search', 'run', { text: 'x'.repeat(2000) })).rejects.toMatchObject({ code: 'invalid_query' })
    await expect(index.call('search', 'run', { text: Array(40).fill('mot').map((m, i) => m + i).join(' ') })).rejects.toMatchObject({ code: 'too_complex' })
    expect(index.capabilities().map(c => c.name)).toEqual(['query', 'search', 'links', 'tags', 'index'])
  })

  it('aucun texte de la requete n entre dans le SQL', async () => {
    const index = await memoryIndex()
    await index.applyDoc({ id: 'a', path: 'A.md', content: "---\n\"x'); DROP TABLE docs; --\": 1\n---\n" })
    const hostile = "x'); DROP TABLE docs; --"
    const r = await index.queryEngine().query({ ...all, where: { field: { prop: hostile }, op: 'eq', value: 1 }, select: [hostile], sort: [{ field: { prop: hostile } }], groupBy: { prop: hostile } })
    expect(r.rows.map(x => x.values)).toEqual([{ [hostile]: 1 }])
    expect((await index.queryEngine().query({ ...all, text: "') OR 1=1 --" })).total).toBe(0)
    expect((await index.searchEngine().search({ text: 'a" OR "b' })).total).toBe(0)
    expect((await index.queryEngine().query(all)).total).toBe(1)
  })

  it('index.status : etat, sequence, nombre de notes, taille', async () => {
    const index = await memoryIndex()
    await index.applyDocs([{ id: 'a', path: 'A.md', content: '' }, { id: 'b', path: 'B.md', content: '' }], { seq: 42 })
    index.setState({ status: 'building', progress: 0.5 })
    const s = await index.call('index', 'status', {}) as Record<string, unknown>
    expect(s).toMatchObject({ status: 'building', progress: 0.5, seq: 42, docs: 2 })
    expect(s.bytes).toBeGreaterThan(0)
    expect((await index.queryEngine().query(all)).index).toEqual({ status: 'building', progress: 0.5 })
  })
})

describe('pagination', () => {
  it('sans tri : ordre de l id, pages completes, curseur lie a sa requete', async () => {
    const index = await memoryIndex()
    await index.applyDocs(Array.from({ length: 23 }, (_, i) => ({ id: `n${String(i).padStart(2, '0')}`, path: `N${i}.md`, content: '' })))
    const seen: string[] = []
    let r = await index.queryEngine().query({ ...all, limit: 5 })
    seen.push(...r.rows.map(x => x.id))
    while (r.next) {
      r = await index.queryEngine().query({ ...all, limit: 5, cursor: r.next })
      seen.push(...r.rows.map(x => x.id))
      expect(r.total).toBe(23)
    }
    expect(seen).toEqual([...seen].sort())
    expect(new Set(seen).size).toBe(23)
    // Une note ajoutee entre deux pages ne decale pas les suivantes.
    const p1 = await index.queryEngine().query({ ...all, limit: 10 })
    await index.applyDoc({ id: 'n00a', path: 'X.md', content: '' })
    const p2 = await index.queryEngine().query({ ...all, limit: 10, cursor: p1.next })
    expect(p2.rows[0].id).toBe('n10')
  })
})

describe('ecriture', () => {
  it('corbeille : une note qui y part sort de l index ; deplacements', async () => {
    const index = await memoryIndex()
    await index.applyDoc({ id: 'a', path: 'A.md', content: 'pomme' })
    expect(await index.moveDoc('a', 'A.md')).toBe('unchanged')
    expect(await index.moveDoc('a', 'Fruits/A.md')).toBe('moved')
    expect((await index.queryEngine().query({ from: { notes: true, folder: 'Fruits' } })).total).toBe(1)
    expect(await index.moveDoc('a', '.trash/A.md', { seq: 7 })).toBe('removed')
    expect((await index.searchEngine().search({ text: 'pomme' })).total).toBe(0)
    expect(await index.seq()).toBe(7)
    expect(await index.moveDoc('a', 'A.md')).toBe('missing')
    await index.applyDoc({ id: 'b', path: 'B.md', content: 'poire' })
    expect(await index.moveDoc('b', 'B.page')).toBe('missing')
    await index.applyDoc({ id: 'c', path: '.trash/C.md', content: 'peche' })
    expect((await index.searchEngine().search({ text: 'peche' })).total).toBe(0)
    expect(await index.paths()).toEqual(new Map())
  })

  it('une note = une transaction : une erreur n ecrit rien', async () => {
    const broken: IndexPower = {
      name: 'casse', version: 1,
      write: (_ctx, _doc, note) => (note.path.includes('casse') ? [sql('INSERT INTO table_absente VALUES (1)')] : []),
    }
    const index = await VaultIndex.open(NodeSqliteDriver.open(':memory:'), { powers: [...defaultPowers(), broken] })
    await index.applyDoc({ id: 'a', path: 'A.md', content: 'avant' })
    await expect(index.applyDocs([
      { id: 'a', path: 'A.md', content: 'apres' },
      { id: 'b', path: 'casse.md', content: 'nouveau' },
    ], { seq: 9 })).rejects.toThrow()
    expect((await index.searchEngine().search({ text: 'avant' })).total).toBe(1)
    expect((await index.searchEngine().search({ text: 'apres' })).total).toBe(0)
    expect(await index.seq()).toBe(0)
    // L'index reste utilisable.
    await index.applyDoc({ id: 'c', path: 'C.md', content: 'ensuite' })
    expect((await index.searchEngine().search({ text: 'ensuite' })).total).toBe(1)
  })

  it('lignes legeres de base : interrogeables, jamais dans la recherche ni les liens', async () => {
    const index = await memoryIndex()
    await index.applyRecords([makeRecord({ id: 'r1', path: '', base: 'B', title: 'Ligne volcan', props: { statut: 'ok' } })])
    expect((await index.queryEngine().query({ from: { base: 'B' }, text: 'volcan' })).total).toBe(1)
    expect((await index.searchEngine().search({ text: 'volcan' })).total).toBe(0)
    expect(((await index.call('links', 'graph', {})) as { nodes: unknown[] }).nodes).toEqual([])
    expect(await index.call('index', 'status', {})).toMatchObject({ docs: 0 })
  })

  it('types des proprietes du vault appliques a l ecriture', async () => {
    const index = await memoryIndex({ schema: { properties: [{ key: 'prix', type: 'number' }] } })
    await index.applyDocs([
      { id: 'a', path: 'A.md', content: '---\nprix: "10"\n---\n' },
      { id: 'b', path: 'B.md', content: '---\nprix: 9\n---\n' },
    ])
    const r = await index.queryEngine().query({ ...all, sort: [{ field: { prop: 'prix' }, dir: 'desc' }] })
    expect(r.rows.map(x => [x.id, x.values.prix])).toEqual([['a', 10], ['b', 9]])
  })
})

describe('extension', () => {
  it('un pouvoir ajoute ses tables, ce qu il tire des notes, ses methodes et ses donnees externes', async () => {
    const longueurs: IndexPower = {
      name: 'longueurs',
      version: 1,
      tables: ['longueurs', 'longueurs_extra'],
      schema: [
        'CREATE TABLE IF NOT EXISTS longueurs (doc INTEGER PRIMARY KEY, n INTEGER NOT NULL)',
        'CREATE TABLE IF NOT EXISTS longueurs_extra (cle TEXT PRIMARY KEY, n INTEGER NOT NULL)',
      ],
      write: (_ctx, doc, note) => [sql('INSERT INTO longueurs (doc, n) VALUES (?, ?)', doc.n, note.sections.map(s => s.text).join('\n').length)],
      remove: (_ctx, doc) => [sql('DELETE FROM longueurs WHERE doc = ?', doc.n)],
      ingest: (_ctx, input) => {
        const { cle, n } = input as { cle: string; n: number }
        return [sql('INSERT OR REPLACE INTO longueurs_extra (cle, n) VALUES (?, ?)', cle, n)]
      },
      methods: {
        total: method({
          parse: () => ({}),
          run: async ctx => {
            const [a] = await ctx.driver.all<{ t: number }>('SELECT coalesce(sum(n), 0) AS t FROM longueurs')
            const [b] = await ctx.driver.all<{ t: number }>('SELECT coalesce(sum(n), 0) AS t FROM longueurs_extra')
            return { notes: a.t, extra: b.t }
          },
        }),
      },
    }
    const index = await VaultIndex.open(NodeSqliteDriver.open(':memory:'), { powers: [...defaultPowers(), longueurs] })
    await index.applyDocs([{ id: 'a', path: 'A.md', content: 'abcd' }, { id: 'b', path: 'B.md', content: 'xy' }])
    await index.applyDoc({ id: 'b', path: 'B.md', content: 'xyz' })
    await index.ingest('longueurs', { cle: 'piece-jointe.pdf', n: 100 })
    expect(await index.call('longueurs', 'total', {})).toEqual({ notes: 7, extra: 100 })
    await expect(index.ingest('tags', {})).rejects.toMatchObject({ code: 'unknown_capability' })
  })
})

describe('suivi', () => {
  it('watch : une requete invalide ne rappelle jamais ; arret', async () => {
    const index = await memoryIndex()
    const cb = vi.fn()
    const stop = index.queryEngine().watch({ ...all, limit: 0 }, cb)
    await index.applyDoc({ id: 'a', path: 'A.md', content: '' })
    await new Promise(r => setTimeout(r, 0))
    expect(cb).not.toHaveBeenCalled()
    stop()
    const seen: number[] = []
    const stop2 = index.queryEngine().watch(all, r => seen.push(r.total))
    await index.applyDoc({ id: 'b', path: 'B.md', content: '' })
    await new Promise(r => setTimeout(r, 0))
    stop2()
    await index.applyDoc({ id: 'c', path: 'C.md', content: '' })
    await new Promise(r => setTimeout(r, 0))
    expect(seen[0]).toBe(1)
    expect(seen.at(-1)).toBe(2)
    expect(seen).not.toContain(3)
  })

  it('etat : prevenu des changements', async () => {
    const index = await memoryIndex()
    const cb = vi.fn()
    index.searchEngine().onStateChange(cb)
    index.setState({ status: 'lagging', lagMs: 1500 })
    expect(cb).toHaveBeenCalledWith({ status: 'lagging', lagMs: 1500 })
    expect(index.searchEngine().state()).toEqual({ status: 'lagging', lagMs: 1500 })
  })
})
