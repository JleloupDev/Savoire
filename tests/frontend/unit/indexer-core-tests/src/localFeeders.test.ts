// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Nourrir l'index local d'un client sans les fichiers (navigateur, pair a
// pair) : metadonnees partagees de toutes les notes, texte des notes lues,
// lignes legeres des bases. Et reprendre sans tout reecrire.
import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { baseLotOf } from '@savoire/plugin-api'
import type { SqlDriver } from '@savoire/indexer-core'
import { NodeSqliteDriver } from '@savoire/indexer-core/node'
import { BaseRowFeeder, DirectLocalIndex, SharedIndexFeeder } from '@savoire/indexer-core/local'
import type { SharedNote } from '@savoire/indexer-core/local'

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

function tempFile(): string {
  const d = mkdtempSync(join(tmpdir(), 'savoire-feed-'))
  dirs.push(d)
  return join(d, 'index.sqlite')
}

/** Compte les transactions qui ecrivent des notes. */
function counting(driver: SqlDriver): { driver: SqlDriver; writes: () => number } {
  let n = 0
  return {
    driver: {
      exec: s => driver.exec(s),
      all: (s, p) => driver.all(s, p),
      batch: stmts => { if (stmts.some(s => /INTO docs/.test(s.sql))) n++; return driver.batch(stmts) },
      close: () => driver.close(),
    },
    writes: () => n,
  }
}

const note = (id: string, path: string, props: SharedNote['props'] = {}): SharedNote => ({
  id, path, title: path.replace(/^.*\//, '').replace(/\.[^.]+$/, ''), props,
})

const NOTES = [
  note('a', 'Projets/Alpha.md', { status: 'En cours', tags: ['client'] }),
  note('b', 'Projets/Beta.md', { status: 'Fini' }),
  note('c', 'Notes/Gamma.md'),
]

async function ids(index: DirectLocalIndex, where?: object): Promise<string[]> {
  const r = await index.queryEngine().query({ from: { notes: true }, ...(where ? { where } : {}), sort: [{ field: { doc: 'path' } }] } as never)
  return r.rows.map(x => x.id)
}

describe('SharedIndexFeeder', () => {
  it('metadonnees de toutes les notes ; reprise sans rien reecrire', async () => {
    const file = tempFile()
    const first = await DirectLocalIndex.open(NodeSqliteDriver.open(file), { persistence: 'disk' })
    expect(first.info.rebuildRequired).toBe(true)
    const feeder = new SharedIndexFeeder(first)
    feeder.setNotes(NOTES)
    await feeder.whenIdle()
    expect(await ids(first, { field: { prop: 'status' }, op: 'eq', value: 'en cours' })).toEqual(['a'])
    expect(await first.call('tags', 'list', {})).toEqual({ items: [{ tag: 'client', count: 1 }] })
    await first.close()

    // Rechargement : meme vault, rien n'a change.
    const c = counting(NodeSqliteDriver.open(file))
    const again = await DirectLocalIndex.open(c.driver, { persistence: 'disk' })
    expect(again.info.rebuildRequired).toBe(false)
    const feeder2 = new SharedIndexFeeder(again)
    feeder2.setNotes(NOTES)
    await feeder2.whenIdle()
    expect(c.writes()).toBe(0)
    // Une note change, une disparait : seules celles-la.
    feeder2.setNotes([note('a', 'Projets/Alpha.md', { status: 'Fini' }), NOTES[2]!])
    await feeder2.whenIdle()
    expect(c.writes()).toBe(1)
    expect(await ids(again)).toEqual(['c', 'a'])
    expect(await ids(again, { field: { prop: 'status' }, op: 'eq', value: 'fini' })).toEqual(['a'])
    await again.close()
  })

  it('texte des notes lues : recherche plein texte, liens ; relu quand la note change ailleurs', async () => {
    const index = await DirectLocalIndex.open(NodeSqliteDriver.open(':memory:'), { persistence: 'memory' })
    const reads: string[] = []
    let remote: string | null = '---\nstatus: Fini\n---\nTexte relu [[Gamma]]'
    const feeder = new SharedIndexFeeder(index, {
      readText: async id => { reads.push(id); if (remote === 'boom') throw new Error('pair absent'); return remote },
    })
    feeder.setNotes(NOTES)
    feeder.noteText('a', 'Projets/Alpha.md', '---\nstatus: En cours\n---\n# Alpha\nLe réseau électrique, voir [[Beta]]')
    await feeder.whenIdle()
    expect((await index.searchEngine().search({ text: 'reseau' })).hits.map(h => h.id)).toEqual(['a'])
    expect(await index.call('links', 'backlinks', { id: 'b' })).toMatchObject({ items: [{ id: 'a' }] })
    // Memes metadonnees : rien n'est relu.
    feeder.setNotes(NOTES)
    await feeder.whenIdle()
    expect(reads).toEqual([])
    const B2 = note('b', 'Projets/Beta.md', { status: 'Fini', extra: 1 })
    // Texte recu, puis les metadonnees qu'il produit : pas de relecture.
    feeder.noteText('b', 'Projets/Beta.md', '---\nstatus: Fini\n---\nRapport banane')
    feeder.setNotes([NOTES[0]!, B2, NOTES[2]!])
    await feeder.whenIdle()
    feeder.setNotes([NOTES[0]!, B2, NOTES[2]!])
    await feeder.whenIdle()
    expect(reads).toEqual([])
    expect((await index.searchEngine().search({ text: 'banane' })).hits.map(h => h.id)).toEqual(['b'])
    // Les metadonnees changent ailleurs : le texte est relu.
    feeder.setNotes([note('a', 'Projets/Alpha.md', { status: 'Fini' }), B2, NOTES[2]!])
    await feeder.whenIdle()
    expect(reads).toEqual(['a'])
    expect((await index.searchEngine().search({ text: 'relu' })).hits.map(h => h.id)).toEqual(['a'])
    expect(await index.call('links', 'backlinks', { id: 'c' })).toMatchObject({ items: [{ id: 'a' }] })
    // Lecture en echec : la note garde son texte, elle sera relue ensuite.
    remote = 'boom'
    feeder.setNotes([note('a', 'Projets/Alpha.md', { status: 'Suspendu' }), B2, NOTES[2]!])
    await feeder.whenIdle()
    expect((await index.searchEngine().search({ text: 'relu' })).hits.map(h => h.id)).toEqual(['a'])
    // Illisible : la note repasse en metadonnees seules, proprietes justes.
    remote = null
    feeder.setNotes([note('a', 'Projets/Alpha.md', { status: 'Annule' }), B2, NOTES[2]!])
    await feeder.whenIdle()
    expect(await ids(index, { field: { prop: 'status' }, op: 'eq', value: 'annule' })).toEqual(['a'])
    expect((await index.searchEngine().search({ text: 'relu' })).hits).toEqual([])
  })

  it('une note indexee sans signature et absente du vault est retiree', async () => {
    const index = await DirectLocalIndex.open(NodeSqliteDriver.open(':memory:'), { persistence: 'memory' })
    await index.index.applyDocs([{ id: 'old', path: 'Vieux.md', content: 'x' }])
    const feeder = new SharedIndexFeeder(index)
    feeder.setNotes(NOTES)
    await feeder.whenIdle()
    expect(await ids(index)).toEqual(['c', 'a', 'b'])
  })

  it('beaucoup de notes : etat en construction, puis pret', async () => {
    const index = await DirectLocalIndex.open(NodeSqliteDriver.open(':memory:'), { persistence: 'memory' })
    const states: string[] = []
    index.onStateChange(s => states.push(s.status))
    const feeder = new SharedIndexFeeder(index, { buildingThreshold: 10, batchSize: 7 })
    feeder.setNotes(Array.from({ length: 30 }, (_, i) => note(`n${i}`, `N/${i}.md`, { i })))
    await feeder.whenIdle()
    expect(states[0]).toBe('building')
    expect(states.at(-1)).toBe('ready')
    expect((await index.queryEngine().query({ from: { notes: true } })).total).toBe(30)
  })
})

describe('BaseRowFeeder', () => {
  it('un lot lu en entier retire ses lignes disparues, pas celles des autres lots', async () => {
    const index = await DirectLocalIndex.open(NodeSqliteDriver.open(':memory:'), { persistence: 'memory' })
    const rows = new BaseRowFeeder(index)
    const lotCount = 4
    const all = Array.from({ length: 40 }, (_, i) => ({ id: `r${i}`, path: '', title: `Ligne ${i}`, props: { n: i } }))
    for (let lot = 0; lot < lotCount; lot++) rows.lot('B', lot, lotCount, all.filter(r => baseLotOf(r.id, lotCount) === lot))
    await rows.whenIdle()
    const count = async () => (await index.queryEngine().query({ from: { base: 'B' } })).total
    expect(await count()).toBe(40)
    // Lot 0 relu : deux de ses lignes ont disparu pendant que l'appli etait fermee.
    const lot0 = all.filter(r => baseLotOf(r.id, lotCount) === 0)
    rows.lot('B', 0, lotCount, lot0.slice(2))
    await rows.whenIdle()
    expect(await count()).toBe(38)
    // Au fil de l'eau : une ligne changee, une supprimee.
    rows.rows([{ ...lot0[2]!, base: 'B', props: { n: 1000 } }], [lot0[3]!.id])
    await rows.whenIdle()
    expect(await count()).toBe(37)
    const r = await index.queryEngine().query({ from: { base: 'B' }, where: { field: { prop: 'n' }, op: 'eq', value: 1000 } })
    expect(r.rows.map(x => x.id)).toEqual([lot0[2]!.id])
    // Les notes ne voient pas les lignes.
    expect((await index.queryEngine().query({ from: { notes: true } })).total).toBe(0)
  })
})
