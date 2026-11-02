// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// API du pair (indexer-protocol.md, « API du pair ») : jeton, erreurs exactes,
// cache invalide quand l'index avance, file bornee (429), recherche globale,
// sante et metriques.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { loadConfig } from '../../../../../apps/indexer/src/config'
import { HttpError } from '../../../../../apps/indexer/src/errors'
import { createLogger } from '../../../../../apps/indexer/src/log'
import { ShardPool } from '../../../../../apps/indexer/src/shards'
import { FakeBackend } from './fakeBackend'
import { Peer, TOKEN, startPeer, tempDir, testEnv, until } from './harness'

let backend: FakeBackend
let peer: Peer
let tmp: { dir: string; cleanup: () => void }

beforeAll(async () => {
  backend = await new FakeBackend({ token: TOKEN, instances: ['idx-a', 'idx-b'], owner: id => (id === 'autre' ? 'idx-b' : 'idx-a') }).start()
  tmp = tempDir()
  for (const v of ['v1', 'v2', 'v3']) {
    for (let i = 0; i < 6; i++) backend.writeNote(v, `${v}-n${i}`, `N${i}.md`, `# ${v} note ${i}\n\n${'reseau '.repeat(i + 1)} electrique ${v}`)
  }
  backend.writeNote('autre', 'x', 'X.md', 'reseau ailleurs')
  peer = await startPeer(backend, tmp.dir, { SAVOIRE_INDEXER_MAX_BODY_BYTES: '2KiB' })
  await until(async () => (await Promise.all(['v1', 'v2', 'v3'].map(v => peer.status(v)))).every(r => r.body.status === 'ready' && r.body.docs === 6), 10_000, 'construction')
})

afterAll(async () => {
  await peer.stop()
  await backend.stop()
  tmp.cleanup()
})

describe('jeton de service', () => {
  it('absent ou faux : 401 ; sante sans jeton ; metriques avec', async () => {
    expect((await peer.request('POST', '/v1/vaults/v1/call', { capability: 'index', method: 'status' }, null)).status).toBe(401)
    const wrong = await peer.request<{ error: { code: string } }>('GET', '/v1/vaults/v1/status', undefined, 'faux-jeton-0123456789')
    expect(wrong.status).toBe(401)
    expect(wrong.body.error.code).toBe('unauthorized')
    expect((await peer.request('GET', '/health/live', undefined, null)).status).toBe(200)
    expect((await peer.request('GET', '/health/ready', undefined, null)).status).toBe(200)
    expect((await peer.request('GET', '/metrics', undefined, null)).status).toBe(401)
    expect((await peer.request('GET', '/metrics')).status).toBe(200)
  })
})

describe('erreurs du protocole', () => {
  it('400, 404, 405, 409, 413 avec { error: { code, message } }', async () => {
    const code = (r: { body: unknown }) => (r.body as { error?: { code?: string } }).error?.code
    let r = await peer.call('v1', 'query', 'run', { from: { notes: true }, where: { field: { prop: 'x' }, op: 'nope', value: 1 } })
    expect([r.status, code(r)]).toEqual([400, 'invalid_query'])
    r = await peer.call('v1', 'search', 'run', { text: 'reseau', cursor: 'abimé' })
    expect([r.status, code(r)]).toEqual([400, 'invalid_cursor'])
    r = await peer.call('v1', 'vecteurs', 'run', {})
    expect([r.status, code(r)]).toEqual([404, 'unknown_capability'])
    r = await peer.call('v1', 'links', 'nope', {})
    expect([r.status, code(r)]).toEqual([404, 'unknown_method'])
    r = await peer.call('autre', 'search', 'run', { text: 'reseau' })
    expect([r.status, code(r)]).toEqual([409, 'not_owner'])
    r = await peer.call('../etc', 'search', 'run', {})
    expect([r.status, code(r)]).toEqual([400, 'invalid_query']) // jamais un chemin de fichier
    r = await peer.request('POST', '/v1/vaults/v%2F1/call', { capability: 'search', method: 'run' })
    expect([r.status, code(r)]).toEqual([400, 'invalid_query'])
    r = await peer.request('POST', '/v1/vaults/v1/call', '{pas du json')
    expect([r.status, code(r)]).toEqual([400, 'invalid_query'])
    r = await peer.request('POST', '/v1/vaults/v1/call', { capability: 'Search!', method: 'run' })
    expect([r.status, code(r)]).toEqual([400, 'invalid_query'])
    r = await peer.request('POST', '/v1/vaults/v1/call', { capability: 'search', method: 'run', params: { text: 'x'.repeat(5000) } })
    expect([r.status, code(r)]).toEqual([413, 'payload_too_large'])
    r = await peer.request('GET', '/v1/vaults/v1/call')
    expect([r.status, code(r)]).toEqual([405, 'method_not_allowed'])
    r = await peer.request('GET', '/nulle-part')
    expect([r.status, code(r)]).toEqual([404, 'not_found'])
  })

  it('statut d un vault : IndexState + seq, docs, bytes', async () => {
    const r = await peer.status('v2')
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ status: 'ready', docs: 6 })
    expect(r.body.bytes).toBeGreaterThan(0)
  })
})

describe('cache de resultats', () => {
  it('meme appel : servi par le cache ; une ecriture dans le vault l invalide', async () => {
    const hits0 = await peer.metric('savoire_indexer_cache_hits_total')
    const a = await peer.call<{ total: number }>('v1', 'search', 'run', { text: 'electrique', limit: 3 })
    const b = await peer.call<{ total: number }>('v1', 'search', 'run', { limit: 3, text: 'electrique' })
    expect(b.body).toEqual(a.body)
    expect(await peer.metric('savoire_indexer_cache_hits_total')).toBe(hits0 + 1)
    backend.writeNote('v1', 'v1-new', 'Nouvelle.md', 'electrique encore')
    await until(async () => (await peer.call<{ total: number }>('v1', 'search', 'run', { text: 'electrique', limit: 3 })).body.result.total === 7, 5000, 'cache invalide')
  })
})

describe('file bornee', () => {
  it('au-dela de MAX_QUEUE par fil : 429 overloaded avec Retry-After', async () => {
    const { config } = loadConfig(testEnv(backend, tmp.dir + '-pool', { SAVOIRE_INDEXER_MAX_QUEUE: '2' }))
    const pool = new ShardPool({
      count: 1, workers: false, init: { config, version: 'test' }, maxQueue: 2, retryAfterS: 3, unavailableRetryAfterS: 5,
      log: createLogger('silent'), onRestart: () => {},
    })
    const calls = Array.from({ length: 5 }, () => pool.call('v1', 'index', 'status', {}, 1000).catch((e: unknown) => e))
    const out = await Promise.all(calls)
    const refused = out.filter(e => e instanceof HttpError && e.status === 429)
    expect(refused).toHaveLength(3)
    expect((refused[0] as HttpError).retryAfter).toBe(3)
    expect((refused[0] as HttpError).code).toBe('overloaded')
    await pool.stop(1000)

    // Par HTTP : la reponse porte Retry-After.
    const slots = (peer.service as unknown as { pool: { slots: { inflight: number }[] } }).pool.slots
    slots[0]!.inflight += 10_000
    try {
      const r = await peer.call('v1', 'tags', 'list', {})
      expect(r.status).toBe(429)
      expect(r.headers.get('retry-after')).toBe('1')
      expect((await peer.request('GET', '/health/ready', undefined, null)).status).toBe(503)
    } finally {
      slots[0]!.inflight -= 10_000
    }
  })
})

describe('recherche globale (POST /v1/search)', () => {
  it('plusieurs vaults fusionnes par pertinence, pages par curseur compose', async () => {
    const all: { id: string; vaultId?: string; score: number }[] = []
    let cursor: string | undefined
    let total = 0
    for (let page = 0; page < 20; page++) {
      const r = await peer.request<{ hits: { id: string; vaultId?: string; score: number }[]; next?: string; total: number; index: { status: string }; partial?: boolean }>(
        'POST', '/v1/search', { vaultIds: ['v1', 'v2', 'v3'], query: { text: 'reseau', limit: 4, ...(cursor ? { cursor } : {}) }, caller: { userId: 'u1' } })
      expect(r.status).toBe(200)
      expect(r.body.partial).toBeUndefined()
      if (page === 0) total = r.body.total
      all.push(...r.body.hits)
      cursor = r.body.next
      if (!cursor) break
    }
    expect(total).toBe(18)
    const ids = all.map(h => `${h.vaultId}/${h.id}`)
    expect(new Set(ids).size).toBe(ids.length)
    expect(all.every(h => ['v1', 'v2', 'v3'].includes(h.vaultId!))).toBe(true)
    // Ordre global : pertinence decroissante d'une page a l'autre.
    for (let i = 1; i < all.length; i++) expect(all[i - 1]!.score).toBeGreaterThanOrEqual(all[i]!.score)
    expect(all.length).toBe(18)
  })

  it('vault d une autre instance : resultat partiel ; curseur illisible : 400', async () => {
    const r = await peer.request<{ hits: { vaultId: string }[]; partial?: boolean }>('POST', '/v1/search', { vaultIds: ['v1', 'autre'], query: { text: 'reseau' } })
    expect(r.status).toBe(200)
    expect(r.body.partial).toBe(true)
    expect(r.body.hits.every(h => h.vaultId === 'v1')).toBe(true)
    const bad = await peer.request<{ error: { code: string } }>('POST', '/v1/search', { vaultIds: ['v1'], query: { text: 'x', cursor: '%%%' } })
    expect([bad.status, bad.body.error.code]).toEqual([400, 'invalid_cursor'])
    const tooMany = await peer.request<{ error: { code: string } }>('POST', '/v1/search', { vaultIds: ['v1'], query: { text: 'x', limit: 100000 } })
    expect([tooMany.status, tooMany.body.error.code]).toEqual([400, 'invalid_query'])
  })
})

describe('metriques', () => {
  it('globales et par vault', async () => {
    const text = await peer.metrics()
    for (const name of [
      'savoire_indexer_ready 1', 'savoire_indexer_calls_total{', 'savoire_indexer_call_latency_seconds{capability="search",quantile="0.95"}',
      'savoire_indexer_queue_depth{', 'savoire_indexer_vault_status{vault="v1",status="ready"} 1', 'savoire_indexer_vault_docs{vault="v2"} 6',
      'savoire_indexer_vault_lag_seconds{vault="v3"}', 'savoire_indexer_feed_cursor', 'savoire_indexer_cache_hits_total',
      'savoire_indexer_backend_requests_total{', 'savoire_indexer_process_resident_memory_bytes',
    ]) expect(text).toContain(name)
  })
})
