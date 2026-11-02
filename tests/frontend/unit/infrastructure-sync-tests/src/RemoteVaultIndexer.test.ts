// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Pair indexeur distant : bascule, nouveaux essais, requetes suivies sans
// rafale, annulation, jeton renouvele. Faux backend (vrai index en memoire)
// et horloge a la main.
import { afterEach, describe, expect, it } from 'vitest'
import { makeRecord } from '@savoire/indexer-core'
import type { VaultIndex } from '@savoire/indexer-core'
import type { QueryResult } from '@savoire/plugin-api'
import type { VaultIndexerStatus } from '@savoire/application'
import { IndexerHttpClient, RemoteVaultIndexer, parseRetryAfter, setAccessTokenRenewer } from '@savoire/infrastructure-sync'
import { fakeIndexerBackend, memoryIndex } from './support/fakeIndexerBackend'
import type { FakeIndexerBackend } from './support/fakeIndexerBackend'

/** Laisse finir les promesses en cours (appels au faux backend compris). */
const flush = () => new Promise(r => setTimeout(r, 0))

function manualClock() {
  let now = 1_000_000
  let nextId = 1
  const timers: { id: number; at: number; fn: () => void }[] = []
  return {
    now: () => now,
    setTimer: (fn: () => void, ms: number) => { const id = nextId++; timers.push({ id, at: now + ms, fn }); return id },
    clearTimer: (id: unknown) => { const i = timers.findIndex(t => t.id === id); if (i >= 0) timers.splice(i, 1) },
    /** Avance l'horloge en declenchant les minuteurs echus, un par un. */
    async advance(ms: number) {
      const end = now + ms
      await flush()
      for (;;) {
        timers.sort((a, b) => a.at - b.at)
        const t = timers[0]
        if (!t || t.at > end) break
        timers.shift()
        now = t.at
        t.fn()
        await flush()
        await flush()
      }
      now = end
      await flush()
    },
    pending: () => timers.length,
  }
}

const note = (id: string, path: string, status: string) => makeRecord({ id, path, title: path, props: { status }, text: '' })

interface Setup {
  index: VaultIndex
  backend: FakeIndexerBackend
  clock: ReturnType<typeof manualClock>
  remote: RemoteVaultIndexer
  statuses: VaultIndexerStatus[]
  seq: { n: number }
}

const opened: RemoteVaultIndexer[] = []
afterEach(() => {
  for (const r of opened.splice(0)) r.dispose()
  setAccessTokenRenewer(null)
})

async function setup(token = 'tok'): Promise<Setup> {
  const index = await memoryIndex()
  const seq = { n: 1 }
  await index.applyRecords([note('a', 'A.md', 'todo'), note('b', 'B.md', 'done')], { seq: seq.n })
  const backend = fakeIndexerBackend({ v1: index })
  const clock = manualClock()
  let current = token
  const remote = new RemoteVaultIndexer('v1', new IndexerHttpClient({ getToken: () => current, fetchFn: backend.fetch }), clock)
  ;(remote as unknown as { setToken: (t: string) => void }).setToken = (t: string) => { current = t }
  opened.push(remote)
  const statuses: VaultIndexerStatus[] = []
  remote.onStatusChange(s => statuses.push(s))
  // Premier coup d'oeil (etat + reglage).
  await clock.advance(0)
  return { index, backend, clock, remote, statuses, seq }
}

const callsTo = (b: FakeIndexerBackend, part: string) => b.calls.filter(c => c.path.includes(part)).length

describe('RemoteVaultIndexer', () => {
  it('interroge le pair par la route publique, jeton compris ; l etat vient du resultat', async () => {
    const { remote, backend } = await setup()
    const r = await remote.query.query({ from: { notes: true }, sort: [{ field: { doc: 'path' } }] })
    expect(r.rows.map(x => x.id)).toEqual(['a', 'b'])
    const call = backend.calls.find(c => c.path === '/api/v1/vaults/v1/index/query/run')!
    expect(call.method).toBe('POST')
    expect(call.auth).toBe('Bearer tok')
    expect(remote.query.state()).toEqual({ status: 'ready' })
    expect(remote.status().mode).toBe('managed')
  })

  it('503 + Retry-After : indisponible, aucun appel avant l echeance, puis reprise', async () => {
    const { remote, backend, clock } = await setup()
    backend.inject({ status: 503, body: { error: { code: 'unavailable', message: 'pair coupe' } }, headers: { 'Retry-After': '7' } })
    await expect(remote.query.query({ from: { notes: true } })).rejects.toMatchObject({ code: 'unavailable' })
    expect(remote.status()).toMatchObject({ state: { status: 'unavailable' }, reason: 'down', retryAt: clock.now() + 7000 })
    const before = backend.calls.length
    // Pendant l'attente : rejet immediat, sans reseau.
    await expect(remote.query.query({ from: { notes: true } })).rejects.toMatchObject({ code: 'unavailable' })
    await expect(remote.search.search({ text: 'a' })).rejects.toMatchObject({ code: 'unavailable' })
    await clock.advance(6_000)
    expect(backend.calls.length).toBe(before)
    // A l'echeance, un seul coup d'oeil ; le pair repond : pret.
    await clock.advance(1_000)
    expect(backend.calls.length).toBe(before + 1)
    expect(remote.status().state.status).toBe('ready')
    expect(remote.status().reason).toBeUndefined()
    expect((await remote.query.query({ from: { notes: true } })).total).toBe(2)
  })

  it('echecs repetes : l attente double, jusqu au plafond', async () => {
    const { remote, backend, clock } = await setup()
    backend.intercept(() => ({ network: true }))
    await expect(remote.call('index', 'status')).rejects.toMatchObject({ code: 'unavailable' })
    const waits: number[] = [remote.status().retryAt! - clock.now()]
    for (let i = 0; i < 5; i++) {
      await clock.advance(remote.status().retryAt! - clock.now())
      waits.push(remote.status().retryAt! - clock.now())
    }
    expect(waits).toEqual([5_000, 10_000, 20_000, 40_000, 60_000, 60_000])
    backend.intercept(null)
    await clock.advance(60_000)
    expect(remote.status().state.status).toBe('ready')
  })

  it('429 : en retard (freine), appels suspendus jusqu a Retry-After', async () => {
    const { remote, backend, clock } = await setup()
    backend.inject({ status: 429, body: { error: { code: 'rate_limited', message: 'trop' } }, headers: { 'Retry-After': '3' } })
    await expect(remote.query.query({ from: { notes: true } })).rejects.toMatchObject({ code: 'unavailable' })
    expect(remote.status()).toMatchObject({ state: { status: 'lagging' }, reason: 'busy' })
    // Premier echec : l'attente minimale (5 s) l'emporte sur Retry-After (3 s).
    expect(remote.status().retryAt).toBe(clock.now() + 5_000)
    await clock.advance(5_000)
    expect(remote.status().state.status).toBe('ready')
  })

  it('vault sans pair, pair d organisation : la raison et l adresse sont visibles', async () => {
    const { remote, backend, clock } = await setup()
    backend.setting = { mode: 'none' }
    await expect(remote.query.query({ from: { notes: true } })).rejects.toMatchObject({ code: 'unavailable' })
    expect(remote.status()).toMatchObject({ state: { status: 'unavailable' }, reason: 'none', mode: 'none' })
    backend.setting = { mode: 'organization', url: 'https://idx.exemple.org' }
    await clock.advance(60_000)
    expect(remote.status()).toMatchObject({ reason: 'organization', mode: 'organization', url: 'https://idx.exemple.org' })
    // Le proprietaire revient au pair gere : essais remis a zero, reprise immediate.
    await remote.setSetting({ mode: 'managed' })
    await flush()
    expect(remote.status()).toMatchObject({ state: { status: 'ready' }, mode: 'managed' })
    expect(remote.status().reason).toBeUndefined()
  })

  it('parametres refuses : erreur du contrat, le pair reste disponible', async () => {
    const { remote } = await setup()
    await expect(remote.query.query({ from: { notes: true }, limit: 0 })).rejects.toMatchObject({ code: 'invalid_query' })
    await expect(remote.call('nope', 'x')).rejects.toMatchObject({ code: 'unavailable' })
    expect(remote.status().state.status).toBe('ready')
    expect(remote.status().reason).toBeUndefined()
  })

  it('annulation : rejet unavailable, sans appel ni changement d etat', async () => {
    const { remote, backend } = await setup()
    const ctrl = new AbortController()
    ctrl.abort()
    const before = backend.calls.length
    await expect(remote.query.query({ from: { notes: true } }, { signal: ctrl.signal })).rejects.toMatchObject({ code: 'unavailable' })
    expect(backend.calls.length).toBe(before)
    expect(remote.status().state.status).toBe('ready')
  })

  it('delai depasse : l appel est abandonne, le pair passe indisponible', async () => {
    const remote = new RemoteVaultIndexer('v1', new IndexerHttpClient({
      getToken: () => 't',
      timeoutMs: 20,
      fetchFn: ((_: string, init: RequestInit) => new Promise((_res, rej) => {
        init.signal?.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' })))
      })) as unknown as typeof fetch,
    }), { setTimer: () => 0, clearTimer: () => {} })
    opened.push(remote)
    await expect(remote.call('index', 'status')).rejects.toMatchObject({ code: 'unavailable' })
    expect(remote.status()).toMatchObject({ state: { status: 'unavailable' }, reason: 'down' })
  })

  it('jeton refuse (401) : renouvele, puis la requete est rejouee une fois', async () => {
    const { remote, backend } = await setup('vieux')
    backend.acceptTokens(['neuf'])
    setAccessTokenRenewer(async rejected => (rejected === 'vieux' ? 'neuf' : null))
    const r = await remote.query.query({ from: { notes: true } })
    expect(r.total).toBe(2)
    const auths = backend.calls.filter(c => c.path.endsWith('/query/run')).map(c => c.auth)
    expect(auths).toEqual(['Bearer vieux', 'Bearer neuf'])
  })

  it('requetes suivies : relancees quand l index avance, jamais en rafale', async () => {
    const { remote, backend, clock, index, seq } = await setup()
    const seen: number[] = []
    const stop = remote.query.watch({ from: { notes: true }, where: { field: { prop: 'status' }, op: 'eq', value: 'todo' } }, r => seen.push(r.total))
    await clock.advance(0)
    expect(seen).toEqual([1])
    const statusBefore = callsTo(backend, '/index/index/status')
    // 50 frappes en une seconde : aucune requete tout de suite.
    for (let i = 0; i < 50; i++) { remote.noteLocalChange('c'); await clock.advance(20) }
    expect(callsTo(backend, '/index/index/status')).toBe(statusBefore)
    expect(remote.status().pending).toBe(1)
    // Le pair indexe la note.
    await index.applyRecords([note('c', 'C.md', 'todo')], { seq: ++seq.n })
    await clock.advance(1_500)
    expect(callsTo(backend, '/index/index/status')).toBe(statusBefore + 1)
    expect(seen).toEqual([1, 2])
    // La derniere frappe est trop recente pour etre sure : un second coup d'oeil, 2 s apres.
    expect(remote.status().pending).toBe(1)
    await clock.advance(2_000)
    expect(callsTo(backend, '/index/index/status')).toBe(statusBefore + 2)
    expect(remote.status().pending).toBe(0)
    // Rien ne bouge : un coup d'oeil toutes les 30 s, sans relance de la requete.
    const queriesBefore = callsTo(backend, '/query/run')
    await clock.advance(120_000)
    expect(callsTo(backend, '/index/index/status')).toBe(statusBefore + 2 + 4)
    expect(callsTo(backend, '/query/run')).toBe(queriesBefore)
    // Un autre membre modifie : l'index avance, la requete se relance au prochain coup d'oeil.
    await index.applyRecords([note('d', 'D.md', 'todo')], { seq: ++seq.n })
    await clock.advance(30_000)
    expect(seen.at(-1)).toBe(3)
    stop()
    // Plus personne ne suit (hors etat affiche) : le rythme reste celui de l'etat.
    expect(clock.pending()).toBeLessThanOrEqual(1)
  })

  it('note ouverte sans modification : plus en attente apres deux coups d oeil sans que le pair bouge', async () => {
    const { remote, clock } = await setup()
    remote.noteLocalChange('a')
    expect(remote.status().pending).toBe(1)
    // Premier coup d'oeil (2 s apres le precedent) : le pair n'a pas bouge.
    await clock.advance(2_000)
    expect(remote.status().pending).toBe(1)
    // Second coup d'oeil 4 s plus tard (l'attente double quand rien ne bouge).
    await clock.advance(4_000)
    expect(remote.status().pending).toBe(0)
  })

  it('le pair revient : les requetes suivies repartent de lui', async () => {
    const { remote, backend, clock, index, seq } = await setup()
    const seen: QueryResult[] = []
    remote.query.watch({ from: { notes: true } }, r => seen.push(r))
    await clock.advance(0)
    backend.intercept(() => ({ status: 503, body: { error: { code: 'unavailable', message: 'x' } }, headers: { 'Retry-After': '5' } }))
    remote.noteLocalChange('a')
    await clock.advance(2_000)
    expect(remote.status().state.status).toBe('unavailable')
    await index.applyRecords([note('e', 'E.md', 'todo')], { seq: ++seq.n })
    backend.intercept(null)
    await clock.advance(5_000)
    expect(remote.status().state.status).toBe('ready')
    expect(seen.at(-1)!.total).toBe(3)
  })

  it('recherche globale : la route de tous les vaults', async () => {
    const one = await memoryIndex()
    const two = await memoryIndex()
    await one.applyDocs([{ id: 'n1', path: 'Volcan.md', content: '# Volcan\n\nLave.\n' }])
    await two.applyDocs([{ id: 'n2', path: 'Etna.md', content: 'Un volcan actif.\n' }])
    const backend = fakeIndexerBackend({ v1: one, v2: two })
    const remote = new RemoteVaultIndexer('v1', new IndexerHttpClient({ getToken: () => 't', fetchFn: backend.fetch }), { setTimer: () => 0, clearTimer: () => {} })
    opened.push(remote)
    const r = await remote.searchAll({ text: 'volcan' })
    expect(r.hits.map(h => [h.vaultId, h.id])).toEqual([['v1', 'n1'], ['v2', 'n2']])
    expect(backend.calls.at(-1)!.path).toBe('/api/v1/search')
  })

  it('Retry-After : secondes ou date', () => {
    expect(parseRetryAfter('5')).toBe(5_000)
    expect(parseRetryAfter(new Date(10_000).toUTCString(), 4_000)).toBe(6_000)
    expect(parseRetryAfter('n importe quoi')).toBeUndefined()
  })
})
