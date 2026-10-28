// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Contrat commun de IQueryEngine. Tout moteur (memoire, SQLite du pair
// indexeur, du bureau, du navigateur) doit le passer : il fixe ce que les
// plugins peuvent attendre d'une requete. Voir ADR-027 et query.ts.
import { describe, it, expect } from 'vitest'
import type { IQueryEngine, Query, QueryResult } from '@savoire/plugin-api'
import type { IndexedDoc } from '@savoire/plugin-runtime'

export interface QueryEngineHarness {
  /** Un moteur qui contient exactement ces notes. */
  open(docs: IndexedDoc[]): Promise<{
    engine: IQueryEngine
    upsert(doc: IndexedDoc): Promise<void>
    remove(id: string): Promise<void>
  }>
}

const doc = (id: string, path: string, props: IndexedDoc['props'] = {}, text = ''): IndexedDoc => ({
  id, path, title: path.replace(/^.*\//, '').replace(/\.[^.]+$/, ''), props, text,
})

/** Petit vault de reference. */
export const SAMPLE: IndexedDoc[] = [
  doc('a', 'Projets/Alpha.md', { status: 'En cours', priority: 2, due: '2026-11-03', tags: ['urgent', 'client'], done: false }, 'Le réseau électrique de la ville'),
  doc('b', 'Projets/Beta.md', { status: 'Terminé', priority: 1, due: '2026-10-01', tags: ['client'], done: true }, 'Rapport final livré'),
  doc('c', 'Projets/Gamma.md', { status: 'en cours', priority: 3, tags: [] }, 'Électricité et réseau'),
  doc('d', 'Notes/Delta.md', { status: 'À faire', due: '2026-12-24' }, 'Idées en vrac'),
  doc('e', 'Notes/Epsilon.page', { priority: 2 }, 'Une page Notion'),
  doc('t', '.trash/Ancien.md', { status: 'En cours' }, 'Supprimé'),
]

const all: Query = { from: { notes: true } }
const ids = (r: QueryResult) => r.rows.map(x => x.id)

export function describeQueryEngineContract(name: string, harness: QueryEngineHarness): void {
  describe(`contrat IQueryEngine — ${name}`, () => {
    const open = () => harness.open(SAMPLE)

    describe('source', () => {
      it('toutes les notes, sans la corbeille', async () => {
        const { engine } = await open()
        const r = await engine.query({ ...all, sort: [{ field: { doc: 'path' } }] })
        expect(ids(r)).toEqual(['d', 'e', 'a', 'b', 'c'])
        expect(r.total).toBe(5)
        expect(r.next).toBeUndefined()
      })

      it('un dossier, des extensions', async () => {
        const { engine } = await open()
        expect((await engine.query({ from: { notes: true, folder: 'Notes' } })).total).toBe(2)
        expect(ids(await engine.query({ from: { notes: true, ext: ['page'] } }))).toEqual(['e'])
      })
    })

    describe('filtres', () => {
      it('texte : sans casse ni accents', async () => {
        const { engine } = await open()
        const r = await engine.query({ ...all, where: { field: { prop: 'status' }, op: 'eq', value: 'EN COURS' }, sort: [{ field: { doc: 'path' } }] })
        expect(ids(r)).toEqual(['a', 'c'])
        const r2 = await engine.query({ ...all, where: { field: { prop: 'status' }, op: 'eq', value: 'a faire' } })
        expect(ids(r2)).toEqual(['d'])
      })

      it('nombres et dates', async () => {
        const { engine } = await open()
        expect(ids(await engine.query({ ...all, where: { field: { prop: 'priority' }, op: 'gte', value: 2 }, sort: [{ field: { doc: 'path' } }] }))).toEqual(['e', 'a', 'c'])
        expect(ids(await engine.query({ ...all, where: { field: { prop: 'due' }, op: 'lt', value: '2026-11-15' }, sort: [{ field: { prop: 'due' } }] }))).toEqual(['b', 'a'])
      })

      it('une valeur vide ne satisfait aucune comparaison, sauf empty', async () => {
        const { engine } = await open()
        const neq = await engine.query({ ...all, where: { field: { prop: 'priority' }, op: 'neq', value: 2 } })
        expect(ids(neq).sort()).toEqual(['b', 'c'])
        const empty = await engine.query({ ...all, where: { field: { prop: 'tags' }, op: 'empty' } })
        expect(ids(empty).sort()).toEqual(['c', 'd', 'e'])
        const notEmpty = await engine.query({ ...all, where: { field: { prop: 'due' }, op: 'notEmpty' } })
        expect(ids(notEmpty).sort()).toEqual(['a', 'b', 'd'])
      })

      it('listes : eq et contains = contient ; in = au moins une ; neq = ne contient pas', async () => {
        const { engine } = await open()
        expect(ids(await engine.query({ ...all, where: { field: { prop: 'tags' }, op: 'eq', value: 'urgent' } }))).toEqual(['a'])
        expect(ids(await engine.query({ ...all, where: { field: { prop: 'tags' }, op: 'contains', value: 'CLIENT' } })).sort()).toEqual(['a', 'b'])
        expect(ids(await engine.query({ ...all, where: { field: { prop: 'tags' }, op: 'in', value: ['urgent', 'autre'] } }))).toEqual(['a'])
        expect(ids(await engine.query({ ...all, where: { field: { prop: 'tags' }, op: 'neq', value: 'urgent' } }))).toEqual(['b'])
      })

      it('texte partiel, debut, champs du document', async () => {
        const { engine } = await open()
        expect(ids(await engine.query({ ...all, where: { field: { doc: 'title' }, op: 'contains', value: 'ph' } }))).toEqual(['a'])
        expect(ids(await engine.query({ ...all, where: { field: { doc: 'title' }, op: 'startsWith', value: 'ep' } }))).toEqual(['e'])
        expect(ids(await engine.query({ ...all, where: { field: { doc: 'folder' }, op: 'eq', value: 'notes' } })).sort()).toEqual(['d', 'e'])
      })

      it('et, ou, non', async () => {
        const { engine } = await open()
        const r = await engine.query({ ...all, where: {
          or: [
            { and: [{ field: { prop: 'status' }, op: 'eq', value: 'en cours' }, { field: { prop: 'priority' }, op: 'gt', value: 2 }] },
            { not: { field: { doc: 'folder' }, op: 'eq', value: 'Projets' } },
          ],
        } })
        expect(ids(r).sort()).toEqual(['c', 'd', 'e'])
      })

      it('un filtre trop complexe est refuse', async () => {
        const { engine } = await open()
        const many = Array.from({ length: 100 }, () => ({ field: { prop: 'x' }, op: 'eq' as const, value: 1 }))
        await expect(engine.query({ ...all, where: { or: many } })).rejects.toMatchObject({ code: 'too_complex' })
      })
    })

    describe('tri et pagination', () => {
      it('plusieurs criteres ; vide en dernier dans les deux sens ; egalite par id', async () => {
        const { engine } = await open()
        const asc = await engine.query({ ...all, sort: [{ field: { prop: 'priority' } }] })
        expect(ids(asc)).toEqual(['b', 'a', 'e', 'c', 'd'])
        const desc = await engine.query({ ...all, sort: [{ field: { prop: 'priority' }, dir: 'desc' }, { field: { doc: 'title' }, dir: 'desc' }] })
        expect(ids(desc)).toEqual(['c', 'e', 'a', 'b', 'd'])
      })

      it('les pages couvrent tout le resultat, une fois, dans l ordre', async () => {
        const { engine } = await open()
        const q: Query = { ...all, sort: [{ field: { doc: 'path' } }], limit: 2 }
        const seen: string[] = []
        let r = await engine.query(q)
        seen.push(...ids(r))
        while (r.next) {
          r = await engine.query({ ...q, cursor: r.next })
          seen.push(...ids(r))
        }
        expect(seen).toEqual(['d', 'e', 'a', 'b', 'c'])
        expect(r.total).toBe(5)
      })

      it('un curseur ne vaut que pour sa requete ; limit borne', async () => {
        const { engine } = await open()
        const first = await engine.query({ ...all, limit: 1 })
        await expect(engine.query({ ...all, where: { field: { prop: 'done' }, op: 'eq', value: true }, cursor: first.next })).rejects.toMatchObject({ code: 'invalid_cursor' })
        await expect(engine.query({ ...all, limit: 0 })).rejects.toMatchObject({ code: 'invalid_query' })
        await expect(engine.query({ ...all, limit: 501 })).rejects.toMatchObject({ code: 'invalid_query' })
      })
    })

    describe('plein texte', () => {
      it('tous les mots, prefixes, sans accents ; titre compris', async () => {
        const { engine } = await open()
        expect(ids(await engine.query({ ...all, text: 'reseau electri' })).sort()).toEqual(['a', 'c'])
        expect(ids(await engine.query({ ...all, text: 'rapport livre' }))).toEqual(['b'])
        expect(ids(await engine.query({ ...all, text: 'gamma' }))).toEqual(['c'])
        expect((await engine.query({ ...all, text: 'supprime' })).total).toBe(0)
      })
    })

    describe('groupes et selection', () => {
      it('comptes sur tout le resultat ; une liste compte chaque valeur ; vides sous null', async () => {
        const { engine } = await open()
        const r = await engine.query({ ...all, groupBy: { prop: 'tags' }, limit: 1 })
        expect(r.groups).toEqual([{ key: null, count: 3 }, { key: 'client', count: 2 }, { key: 'urgent', count: 1 }])
      })

      it('select ne renvoie que les proprietes demandees', async () => {
        const { engine } = await open()
        const r = await engine.query({ ...all, where: { field: { doc: 'title' }, op: 'eq', value: 'Alpha' }, select: ['status', 'absente'] })
        expect(r.rows[0]).toMatchObject({ id: 'a', path: 'Projets/Alpha.md', title: 'Alpha', values: { status: 'En cours' } })
        expect(Object.keys(r.rows[0].values)).toEqual(['status'])
      })
    })

    describe('suivi', () => {
      it('watch rend le resultat a jour apres un ajout et une suppression', async () => {
        const { engine, upsert, remove } = await open()
        const seen: number[] = []
        const stop = engine.watch({ ...all, where: { field: { prop: 'status' }, op: 'eq', value: 'en cours' } }, r => seen.push(r.total))
        await upsert(doc('f', 'Projets/Phi.md', { status: 'En cours' }))
        await remove('a')
        await new Promise(r => setTimeout(r, 0))
        stop()
        expect(seen[0]).toBe(2)
        expect(seen.at(-1)).toBe(2)
        expect(seen).toContain(3)
        expect(engine.state().status).toBe('ready')
      })
    })
  })
}
