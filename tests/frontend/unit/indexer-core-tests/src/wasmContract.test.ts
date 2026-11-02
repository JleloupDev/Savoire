// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Le pilote SQLite WebAssembly (navigateur) passe les contrats des requetes
// et de la recherche, a l'identique du moteur en memoire et de node:sqlite.
// Dans Node, SQLite WebAssembly tourne en memoire (pas d'OPFS) : c'est le
// meme SQLite (3.54, FTS5) que dans le Worker du navigateur.
import { describe, it, expect } from 'vitest'
import { VaultIndex } from '@savoire/indexer-core'
import { WasmSqliteDriver, loadSqlite, openWasmDatabase } from '@savoire/indexer-core/wasm'
import { describeQueryEngineContract } from '../../plugin-runtime-tests/src/contract/queryEngineContract'
import { describeSearchEngineContract } from '../../plugin-runtime-tests/src/contract/searchEngineContract'
import { recordOf } from './helpers'

async function wasmIndex(): Promise<VaultIndex> {
  const sqlite3 = await loadSqlite()
  return VaultIndex.open(new WasmSqliteDriver(new sqlite3.oo1.DB(':memory:', 'c'), { journal: 'memory' }))
}

describeQueryEngineContract('SQLite WebAssembly', {
  async open(docs) {
    const index = await wasmIndex()
    await index.applyRecords(docs.map(recordOf))
    return {
      engine: index.queryEngine(),
      upsert: d => index.applyRecords([recordOf(d)]),
      remove: id => index.removeDoc(id),
    }
  },
})

describeSearchEngineContract('SQLite WebAssembly FTS5', {
  async open(notes) {
    const index = await wasmIndex()
    await index.applyDocs(notes)
    return {
      engine: index.searchEngine(),
      upsert: n => index.applyDoc(n),
      remove: id => index.removeDoc(id),
    }
  },
})

describe('pilote SQLite WebAssembly', () => {
  it('SQLite 3.54 avec FTS5 sans contenu et JSON', async () => {
    const sqlite3 = await loadSqlite()
    expect(sqlite3.version.libVersion).toBe('3.54.1')
    const d = new WasmSqliteDriver(new sqlite3.oo1.DB(':memory:', 'c'))
    await d.exec("CREATE VIRTUAL TABLE f USING fts5(t, content='', contentless_delete=1, tokenize='unicode61 remove_diacritics 2')")
    await d.batch([{ sql: 'INSERT INTO f (rowid, t) VALUES (?, ?)', params: [1, 'Été réseau'] }])
    expect(await d.all('SELECT rowid AS r FROM f WHERE f MATCH ?', ['reseau'])).toEqual([{ r: 1 }])
    expect(await d.all('SELECT value AS v FROM json_each(?)', ['[1,"a"]'])).toEqual([{ v: 1 }, { v: 'a' }])
    await d.close()
  })

  it('un batch est tout ou rien, et les instructions en cache restent utilisables', async () => {
    const sqlite3 = await loadSqlite()
    const d = new WasmSqliteDriver(new sqlite3.oo1.DB(':memory:', 'c'))
    await d.exec('CREATE TABLE t (k TEXT PRIMARY KEY, v)')
    await d.batch([{ sql: 'INSERT INTO t VALUES (?, ?)', params: ['a', 1] }])
    await expect(d.batch([
      { sql: 'INSERT INTO t VALUES (?, ?)', params: ['b', 2] },
      { sql: 'INSERT INTO t VALUES (?, ?)', params: ['a', 3] },
    ])).rejects.toThrow()
    expect(await d.all('SELECT k, v FROM t ORDER BY k')).toEqual([{ k: 'a', v: 1 }])
    await d.batch([{ sql: 'INSERT INTO t VALUES (?, ?)', params: ['c', new Uint8Array([1, 2])] }])
    const [row] = await d.all<{ v: Uint8Array }>('SELECT v FROM t WHERE k = ?', ['c'])
    expect([...row!.v]).toEqual([1, 2])
    await d.close()
  })

  it('sans OPFS (Node), la persistance demandee se replie en memoire et le dit', async () => {
    const db = await openWasmDatabase('vault-1', 'opfs')
    expect(db.persistence).toBe('memory')
    expect(db.note).toMatch(/OPFS/)
    await db.driver.close()
  })
})
