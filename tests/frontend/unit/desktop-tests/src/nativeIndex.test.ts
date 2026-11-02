// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Le pilote natif du bureau (TauriSqlDriver -> commandes Rust, rusqlite)
// passe les contrats des requetes et de la recherche, a l'identique du
// moteur en memoire. Sans fenetre : le meme code Rust (src/index_db.rs) est
// servi en lignes JSON par le pont de test examples/index_stdio.rs, que l'on
// joint par le meme pilote TypeScript (meme encodage des valeurs).
//
// Pont absent (Rust non installe) : ces tests sont sautes. Pour les lancer :
//   cd apps/desktop/src-tauri && cargo build --example index_stdio
import { describe, it, expect, afterAll } from 'vitest'
import { spawn } from 'node:child_process'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { resolve } from 'node:path'
import { VaultIndex, makeRecord } from '@savoire/indexer-core'
import { TauriSqlDriver } from '@savoire/indexer-core/tauri'
import type { TauriInvoke } from '@savoire/indexer-core/tauri'
import type { IndexedDoc } from '@savoire/plugin-runtime'
import { describeQueryEngineContract } from '../../plugin-runtime-tests/src/contract/queryEngineContract'
import { describeSearchEngineContract } from '../../plugin-runtime-tests/src/contract/searchEngineContract'

const BRIDGE = resolve(__dirname, '../../../../../apps/desktop/src-tauri/target/debug/examples/index_stdio')
const available = existsSync(BRIDGE)
if (!available) console.warn(`[nativeIndex] pont Rust absent (${BRIDGE}) : tests du pilote natif sautes`)

const children: ChildProcessWithoutNullStreams[] = []
afterAll(() => { for (const c of children) c.kill() })

/** invoke() de Tauri, joue par le pont de test : memes commandes, memes arguments. */
function bridgeInvoke(): TauriInvoke {
  const child = spawn(BRIDGE, [':memory:'])
  children.push(child)
  const waiting: { resolve(v: unknown): void; reject(e: unknown): void }[] = []
  createInterface({ input: child.stdout }).on('line', line => {
    const reply = JSON.parse(line) as { ok: boolean; value?: unknown; error?: string }
    const w = waiting.shift()!
    if (reply.ok) w.resolve(reply.value)
    else w.reject(new Error(reply.error))
  })
  const ops: Record<string, string> = { index_exec: 'exec', index_all: 'all', index_batch: 'batch' }
  return <T>(cmd: string, args: Record<string, unknown>) => {
    if (cmd === 'index_close') { child.stdin.end(); return Promise.resolve(undefined as T) }
    return new Promise<T>((res, rej) => {
      waiting.push({ resolve: v => res(v as T), reject: rej })
      const { root: _root, ...rest } = args
      child.stdin.write(JSON.stringify({ op: ops[cmd], ...rest }) + '\n')
    })
  }
}

function nativeIndex(): Promise<VaultIndex> {
  return VaultIndex.open(new TauriSqlDriver(bridgeInvoke(), '/vault'))
}

function recordOf(d: IndexedDoc) {
  return makeRecord({
    id: d.id, path: d.path, title: d.title, props: d.props, text: d.text,
    ...(d.base !== undefined ? { base: d.base } : {}),
    ...(d.created ? { created: d.created } : {}),
    ...(d.modified ? { modified: d.modified } : {}),
  })
}

if (available) {
  describeQueryEngineContract('SQLite natif (rusqlite, pilote Tauri)', {
    async open(docs) {
      const index = await nativeIndex()
      await index.applyRecords(docs.map(recordOf))
      // Une requete suivie relancee par l'ecriture fait un aller-retour de
      // plus vers le processus Rust : on attend qu'elle soit passee (file de
      // l'index) avant de rendre la main, comme le ferait la fenetre.
      const settled = async () => { await index.seq() }
      return {
        engine: index.queryEngine(),
        upsert: async d => { await index.applyRecords([recordOf(d)]); await settled() },
        remove: async id => { await index.removeDoc(id); await settled() },
      }
    },
  })

  describeSearchEngineContract('SQLite natif FTS5 (rusqlite, pilote Tauri)', {
    async open(notes) {
      const index = await nativeIndex()
      await index.applyDocs(notes)
      return {
        engine: index.searchEngine(),
        upsert: n => index.applyDoc(n),
        remove: id => index.removeDoc(id),
      }
    },
  })
}

describe.skipIf(!available)('pilote natif', () => {
  it('valeurs : entiers, reels, textes, NULL, BLOB', async () => {
    const d = new TauriSqlDriver(bridgeInvoke(), '/vault')
    const [row] = await d.all('SELECT ? AS i, typeof(?) AS ti, ? AS r, ? AS t, ? AS n, ? AS b', [3, 3, 0.5, 'é', null, new Uint8Array([0, 255])])
    expect(row).toMatchObject({ i: 3, ti: 'integer', r: 0.5, t: 'é', n: null })
    expect([...(row!.b as Uint8Array)]).toEqual([0, 255])
    await expect(d.exec("ATTACH DATABASE 'x.sqlite' AS x")).rejects.toThrow()
  })
})
