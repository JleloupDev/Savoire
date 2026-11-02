// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// L'index local du navigateur vu du fil principal : WorkerLocalIndex parle
// par messages a un DirectLocalIndex (SQLite WebAssembly) servi par
// serveLocalIndex. Ici, les deux bouts d'un MessageChannel de Node jouent le
// fil principal et le Worker : memes messages (clonage structure), meme code.
import { describe, it, expect, afterEach } from 'vitest'
import { IndexError } from '@savoire/indexer-core'
import { WorkerLocalIndex, serveLocalIndex } from '@savoire/indexer-core/local'
import type { MessagePortLike } from '@savoire/indexer-core/local'
import { openWasmLocalIndex } from '@savoire/indexer-core/wasm'
import type { QueryResult } from '@savoire/plugin-api'
import { describeQueryEngineContract } from '../../plugin-runtime-tests/src/contract/queryEngineContract'
import { describeSearchEngineContract } from '../../plugin-runtime-tests/src/contract/searchEngineContract'
import { recordOf } from './helpers'

const opened: { close(): void }[] = []
afterEach(() => { for (const c of opened.splice(0)) c.close() })

async function workerIndex(): Promise<WorkerLocalIndex> {
  const channel = new MessageChannel()
  opened.push(channel.port1, channel.port2)
  serveLocalIndex(channel.port1 as unknown as MessagePortLike, openWasmLocalIndex)
  return WorkerLocalIndex.open(channel.port2 as unknown as MessagePortLike, { name: 'test', persistence: 'memory' })
}

describeQueryEngineContract('SQLite WebAssembly par messages (Worker)', {
  async open(docs) {
    const index = await workerIndex()
    await index.applyRecords(docs.map(recordOf))
    // La requete suivie relancee par l'ecriture part du fil principal a
    // l'evenement `changed` ; un appel envoye apres passe apres elle.
    const settled = async () => { await index.call('index', 'status', {}) }
    return {
      engine: index.queryEngine(),
      upsert: async d => { await index.applyRecords([recordOf(d)]); await settled() },
      remove: async id => { await index.removeDocs([id]); await settled() },
    }
  },
})

describeSearchEngineContract('SQLite WebAssembly FTS5 par messages (Worker)', {
  async open(notes) {
    const index = await workerIndex()
    await index.applyDocs(notes)
    return {
      engine: index.searchEngine(),
      upsert: n => index.applyDocs([n]),
      remove: id => index.removeDocs([id]),
    }
  },
})

describe('index local par messages', () => {
  it('ouverture : persistance et reconstruction annoncees', async () => {
    const index = await workerIndex()
    expect(index.info).toEqual({ persistence: 'memory', rebuildRequired: true })
  })

  it('erreurs avec les codes du protocole', async () => {
    const index = await workerIndex()
    const err = await index.call('nope', 'run', {}).catch(e => e)
    expect(err).toBeInstanceOf(IndexError)
    expect(err.code).toBe('unknown_capability')
    const bad = await index.queryEngine().query({ from: { notes: true }, limit: -1 } as never).catch(e => e)
    expect(bad.code).toBe('invalid_query')
  })

  it('annulation : la promesse rejette tout de suite avec unavailable', async () => {
    const index = await workerIndex()
    const ctl = new AbortController()
    ctl.abort()
    expect((await index.call('index', 'status', {}, { signal: ctl.signal }).catch(e => e)).code).toBe('unavailable')
    const late = new AbortController()
    const p = index.searchEngine().search({ text: 'x' }, { signal: late.signal })
    late.abort()
    expect((await p.catch(e => e)).code).toBe('unavailable')
    // L'index repond toujours ensuite.
    expect((await index.call('index', 'status', {}) as { docs: number }).docs).toBe(0)
  })

  it('requete suivie relancee a chaque changement ; etat transmis', async () => {
    const index = await workerIndex()
    const results: QueryResult[] = []
    const stop = index.queryEngine().watch({ from: { notes: true } }, r => results.push(r))
    await new Promise(r => setTimeout(r, 30))
    await index.applyDocs([{ id: 'a', path: 'A.md', content: '# A' }], { a: 'sig-a' })
    await new Promise(r => setTimeout(r, 30))
    expect(results.at(-1)?.total).toBe(1)
    const states: string[] = []
    index.onStateChange(s => states.push(s.status))
    index.setState({ status: 'building', progress: 0.5 })
    expect(index.state()).toEqual({ status: 'building', progress: 0.5 })
    await new Promise(r => setTimeout(r, 30))
    expect(results.at(-1)?.index).toEqual({ status: 'building', progress: 0.5 })
    stop()
    expect(states[0]).toBe('building')
    expect([...(await index.sources())]).toEqual([['a', 'sig-a']])
    expect([...(await index.paths())]).toEqual([['a', 'A.md']])
  })

  it('fermeture : plus aucun appel', async () => {
    let disposed = false
    const channel = new MessageChannel()
    opened.push(channel.port1, channel.port2)
    serveLocalIndex(channel.port1 as unknown as MessagePortLike, openWasmLocalIndex)
    const index = await WorkerLocalIndex.open(channel.port2 as unknown as MessagePortLike, { name: 'x', persistence: 'memory' }, { dispose: () => { disposed = true } })
    await index.close()
    expect(disposed).toBe(true)
    expect((await index.call('index', 'status', {}).catch(e => e)).code).toBe('unavailable')
  })
})
