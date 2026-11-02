// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Bases et lignes legeres lues dans leurs CRDT, ecrits comme le fait
// plugin-base (arbre partage : manifeste sous 'base', une carte `row:<id>`
// par ligne dans chaque lot), puis indexees et interrogees (source { base }).
import { describe, it, expect } from 'vitest'
import * as Y from 'yjs'
import {
  VaultIndex, baseManifestFromUpdates, lightRowRecord, lotDocId, lotRowsFromUpdates, parseLotDocId,
} from '@savoire/indexer-core'
import { NodeSqliteDriver } from '@savoire/indexer-core/node'
import { BASE_LOT_COUNT, baseLotOf } from '@savoire/plugin-api'
import { YjsSharedTree } from '../../../../../packages/infrastructure-sync/src/YjsSharedTree'

const state = (doc: Y.Doc) => [Buffer.from(Y.encodeStateAsUpdate(doc)).toString('base64')]

describe('bases', () => {
  it('id des lots', () => {
    expect(lotDocId('b1', 7)).toBe('b1~lot-007')
    expect(parseLotDocId('b1~lot-007')).toEqual({ baseId: 'b1', lot: 7 })
    expect(parseLotDocId('a~b~lot-123')).toEqual({ baseId: 'a~b', lot: 123 })
    expect(parseLotDocId('b1')).toBeNull()
    expect(parseLotDocId('b1~lot-7')).toBeNull()
  })

  it('manifeste : nombre de lots et lots existants', () => {
    const doc = new Y.Doc()
    const tree = new YjsSharedTree(doc)
    expect(baseManifestFromUpdates(state(doc))).toBeNull()
    tree.root.set('base', { kind: 'map', entries: { lotCount: 16, lots: { kind: 'map', entries: { '3': true, '0': true } } } })
    expect(baseManifestFromUpdates(state(doc))).toEqual({ lotCount: 16, lots: [0, 3] })
    const bare = new Y.Doc()
    new YjsSharedTree(bare).root.set('base', { kind: 'map', entries: {} })
    expect(baseManifestFromUpdates(state(bare))).toEqual({ lotCount: BASE_LOT_COUNT, lots: [] })
  })

  it('lignes d un lot : titre, valeurs typees, listes, textes ; indexees et interrogees', async () => {
    const doc = new Y.Doc()
    const tree = new YjsSharedTree(doc)
    tree.transact(() => {
      tree.root.set('row:r1', { kind: 'map', entries: { title: 'Alpha', prix: 12, statut: '"fait"', tags: { kind: 'list', items: ['a', 'b'] } } })
      tree.root.set('row:r2', { kind: 'map', entries: { title: 'Beta', prix: 3, fini: true, note: { kind: 'text', delta: [{ insert: 'du texte' }] } } })
      tree.root.set('autre', 1)
    })
    const rows = lotRowsFromUpdates(state(doc)).sort((a, b) => a.id.localeCompare(b.id))
    expect(rows).toEqual([
      { id: 'r1', title: 'Alpha', values: { prix: 12, statut: '"fait"', tags: ['a', 'b'] } },
      { id: 'r2', title: 'Beta', values: { prix: 3, fini: true, note: 'du texte' } },
    ])

    const index = await VaultIndex.open(NodeSqliteDriver.open(':memory:'))
    await index.applyRecords(rows.map(r => lightRowRecord('B', r)))
    const res = await index.queryEngine().query({ from: { base: 'B' }, where: { field: { prop: 'prix' }, op: 'gt', value: 5 } })
    expect(res.rows.map(r => [r.id, r.title, r.values['statut']])).toEqual([['r1', 'Alpha', 'fait']])
    expect(await index.bases()).toEqual(['B'])
    expect((await index.rowIds('B')).sort()).toEqual(['r1', 'r2'])
    // Les lignes d'un lot : celles dont le hachage tombe dans ce lot.
    expect(['r1', 'r2'].map(id => baseLotOf(id, 4) < 4)).toEqual([true, true])
  })
})
