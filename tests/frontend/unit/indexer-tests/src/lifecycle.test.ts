// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Vie du pair : reprise apres redemarrage sans reconstruction, arret propre,
// backend coupe (pret / pas pret, etat « en retard »), vaults orphelins,
// version de schema changee (reconstruction a cote pendant que l'ancien
// repond), fichier d'index abime.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { defaultPowers, tagsPower } from '@savoire/indexer-core'
import { NodeSqliteDriver } from '@savoire/indexer-core/node'
import { FakeBackend } from './fakeBackend'
import { Peer, TOKEN, sleep, startPeer, tempDir, until } from './harness'

let backend: FakeBackend
let peer: Peer | undefined
let tmp: { dir: string; cleanup: () => void }

beforeEach(async () => {
  backend = await new FakeBackend({ token: TOKEN, instances: ['idx-a', 'idx-b'] }).start()
  tmp = tempDir()
})

afterEach(async () => {
  await peer?.stop()
  peer = undefined
  await backend.stop()
  tmp.cleanup()
})

describe('redemarrage et arret', () => {
  it('reprend ou il s etait arrete : pas de reconstruction, seules les notes changees sont relues', async () => {
    for (let i = 0; i < 20; i++) backend.writeNote('v1', `n${i}`, `N${i}.md`, `note ${i} premier`)
    peer = await startPeer(backend, tmp.dir)
    await until(async () => (await peer!.found('v1', 'premier')).length === 20, 8000, 'construction')
    await sleep(1200) // la position sure est ecrite chaque seconde
    await peer.stop()
    peer = undefined
    const state = JSON.parse(readFileSync(join(tmp.dir, 'indexer-state.json'), 'utf8'))
    expect(state).toMatchObject({ version: 1, name: 'idx-a', epoch: 'epoch-1' })
    expect(state.cursor).toBeGreaterThan(0)
    expect(existsSync(join(tmp.dir, '.lock'))).toBe(false)

    // Pendant l'arret : une note modifiee, une nouvelle, un renommage.
    backend.writeNote('v1', 'n4', 'N4.md', 'note 4 modifiee pendant l arret')
    backend.writeNote('v1', 'n99', 'N99.md', 'nouvelle pendant l arret')
    backend.rename('v1', 'n5', 'Dossier/N5.md')
    backend.docReads.clear()

    peer = await startPeer(backend, tmp.dir)
    await until(async () => (await peer!.found('v1', 'arret')).length === 2, 8000, 'reprise')
    await until(async () => {
      const r = await peer!.call<{ rows: { id: string }[] }>('v1', 'query', 'run', { from: { notes: true, folder: 'Dossier' } })
      return r.body.result.rows.length === 1
    }, 5000, 'renommage')
    expect(await peer.metric('savoire_indexer_builds_total')).toBe(0)
    expect([...backend.docReads.keys()].sort()).toEqual(['n4', 'n99'])
    expect((await peer.status('v1')).body).toMatchObject({ status: 'ready', docs: 21 })
  })

  it('arret propre : appels en cours servis, fichiers fermes (WAL vide), plus rien n est accepte', async () => {
    for (let i = 0; i < 10; i++) backend.writeNote('v1', `n${i}`, `N${i}.md`, `texte ${i}`)
    peer = await startPeer(backend, tmp.dir)
    await until(async () => (await peer!.found('v1', 'texte')).length === 10, 8000, 'construction')
    const url = peer.url
    // Un appel lent, deja recu quand l'arret commence.
    const pool = (peer.service as unknown as { pool: { call: (...a: unknown[]) => Promise<unknown> } }).pool
    const original = pool.call.bind(pool)
    pool.call = async (...a: unknown[]) => { await sleep(300); return original(...a) }
    const inflight = peer.call('v1', 'search', 'run', { text: 'texte' })
    await sleep(100)
    const stopping = peer.stop()
    expect((await inflight).status).toBe(200)
    await stopping
    peer = undefined
    await expect(fetch(url + '/health/live')).rejects.toThrow()
    // Ferme proprement : le journal WAL a ete reverse dans la base.
    expect(readdirSync(tmp.dir).filter(f => f.endsWith('-wal'))).toEqual([])
    const db = NodeSqliteDriver.open(join(tmp.dir, 'v1.sqlite'), { readOnly: true })
    expect(await db.all('PRAGMA integrity_check')).toEqual([{ integrity_check: 'ok' }])
    await db.close()
  })
})

describe('mode degrade', () => {
  it('backend coupe : les appels repondent toujours (en retard), ready faux, puis tout reprend', async () => {
    backend.writeNote('v1', 'a', 'A.md', 'alpha')
    peer = await startPeer(backend, tmp.dir, { SAVOIRE_INDEXER_FEED_STALE_MS: '500', SAVOIRE_INDEXER_LAG_WARN_MS: '300' })
    await until(async () => (await peer!.found('v1', 'alpha')).length === 1, 5000, 'construction')
    expect((await peer.request('GET', '/health/ready', undefined, null)).status).toBe(200)
    backend.down = true
    await until(async () => (await peer!.request('GET', '/health/ready', undefined, null)).status === 503, 5000, 'pas pret')
    const r = await peer.call<{ hits: unknown[]; index: { status: string; lagMs?: number } }>('v1', 'search', 'run', { text: 'alpha' })
    expect(r.status).toBe(200)
    expect(r.body.result.hits).toHaveLength(1)
    expect(r.body.result.index.status).toBe('lagging')
    backend.down = false
    backend.writeNote('v1', 'b', 'B.md', 'retour du backend')
    await until(async () => (await peer!.found('v1', 'retour')).length === 1, 40_000, 'reprise')
    await until(async () => (await peer!.request('GET', '/health/ready', undefined, null)).status === 200, 5000, 'pret')
  }, 60_000)
})

describe('repartition', () => {
  it('vault parti vers une autre instance : orphelin (409), supprime apres ORPHAN_TTL ; revenu avant : reconstruit', async () => {
    let owners: Record<string, string> = { v1: 'idx-a', v2: 'idx-a' }
    backend.owner = id => owners[id] ?? 'idx-a'
    backend.writeNote('v1', 'a', 'A.md', 'alpha')
    backend.writeNote('v2', 'b', 'B.md', 'beta')
    peer = await startPeer(backend, tmp.dir, { SAVOIRE_INDEXER_VAULTS_REFRESH_MS: '200', SAVOIRE_INDEXER_ORPHAN_TTL: '1500ms' })
    await until(async () => (await peer!.found('v1', 'alpha')).length === 1 && (await peer!.found('v2', 'beta')).length === 1, 5000, 'construction')

    owners = { v1: 'idx-b', v2: 'idx-b' }
    await until(async () => (await peer!.call('v1', 'search', 'run', { text: 'alpha' })).status === 409, 5000, 'orphelin')
    expect(existsSync(join(tmp.dir, 'v1.sqlite.stale'))).toBe(true)
    // v2 revient avant le delai : perime, reconstruit a cote.
    owners = { v2: 'idx-a', v1: 'idx-b' }
    backend.writeNote('v2', 'c', 'C.md', 'gamma ecrite pendant l absence')
    await until(async () => (await peer!.found('v2', 'gamma')).length === 1, 8000, 'retour')
    await until(() => !existsSync(join(tmp.dir, 'v2.sqlite.stale')), 5000, 'marque retiree')
    // v1 : supprime apres le delai.
    await until(() => !existsSync(join(tmp.dir, 'v1.sqlite')), 8000, 'orphelin supprime')
    expect(existsSync(join(tmp.dir, 'v1.sqlite.stale'))).toBe(false)
  })
})

describe('schema versionne', () => {
  it('version d un pouvoir changee : reconstruit a cote, l ancien repond pendant ce temps, puis bascule', async () => {
    for (let i = 0; i < 60; i++) backend.writeNote('v1', `n${i}`, `N${i}.md`, `---\nstatut: ${i % 2 ? 'fait' : 'ouvert'}\n---\nnote ${i} #t${i % 4}`)
    peer = await startPeer(backend, tmp.dir)
    await until(async () => (await peer!.status('v1')).body.docs === 60 && (await peer!.status('v1')).body.status === 'ready', 8000, 'construction')
    await peer.stop()

    // Nouvelle version du pouvoir `tags` ; le backend est lent : la reconstruction dure.
    const powers = () => defaultPowers().map(p => (p.name === 'tags' ? { ...tagsPower, version: tagsPower.version + 1 } : p))
    backend.docLatencyMs = 15
    peer = await startPeer(backend, tmp.dir, { SAVOIRE_INDEXER_BUILD_BATCH: '5', SAVOIRE_INDEXER_FETCH_CONCURRENCY: '2' }, powers)
    await until(() => existsSync(join(tmp.dir, 'v1.sqlite.building')), 5000, 'construction a cote')
    // Pendant ce temps, les requetes (pouvoir intact) repondent en entier, avec l'etat « building ».
    const q = await peer.call<{ total: number; index: { status: string; progress?: number } }>('v1', 'query', 'run', { from: { notes: true }, where: { field: { prop: 'statut' }, op: 'eq', value: 'fait' } })
    expect(q.body.result.total).toBe(30)
    expect(q.body.result.index.status).toBe('building')
    // Une note ecrite pendant la construction arrive dans les deux index.
    backend.writeNote('v1', 'pendant', 'Pendant.md', 'ecrite pendant la reconstruction #t9')
    await until(async () => (await peer!.found('v1', 'reconstruction')).length === 1, 10_000, 'note pendant')
    await until(async () => (await peer!.status('v1')).body.status === 'ready', 20_000, 'bascule')
    expect(existsSync(join(tmp.dir, 'v1.sqlite.building'))).toBe(false)
    const tags = await peer.call<{ items: { tag: string; count: number }[] }>('v1', 'tags', 'list', {})
    expect(tags.body.result.items.find(t => t.tag === 't9')?.count).toBe(1)
    expect(tags.body.result.items.reduce((n, t) => n + t.count, 0)).toBe(61)
    expect(await peer.found('v1', 'reconstruction')).toEqual(['pendant'])
    expect(await peer.metric('savoire_indexer_builds_total', { mode: 'beside', result: 'ok' })).toBe(1)
  }, 60_000)

  it('fichier d index abime : supprime et reconstruit', async () => {
    backend.writeNote('v1', 'a', 'A.md', 'alpha')
    writeFileSync(join(tmp.dir, 'v1.sqlite'), 'ceci n est pas une base SQLite'.repeat(200))
    peer = await startPeer(backend, tmp.dir)
    await until(async () => (await peer!.found('v1', 'alpha')).length === 1, 5000, 'reconstruit')
    expect(await peer.metric('savoire_indexer_errors_total', { kind: 'corrupt' })).toBe(1)
  })
})
