// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Pieces du pair sans reseau : configuration, priorites du creneau SQLite,
// cache de resultats, fusion de la recherche globale, metriques, jeton.
import { describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConfigError, loadConfig, parseBytes, parseDuration, settingsTable } from '../../../../../apps/indexer/src/config'
import { ResultCache } from '../../../../../apps/indexer/src/cache'
import { decodeCursor, encodeCursor, mergePages, worstIndex } from '../../../../../apps/indexer/src/globalSearch'
import { tokenMatches } from '../../../../../apps/indexer/src/http'
import { Counter, Histogram, render } from '../../../../../apps/indexer/src/metrics'
import { BUILD, INTERACTIVE, LIVE, PrioritySlot, SlotAbortedError } from '../../../../../apps/indexer/src/sched'
import { stableStringify } from '../../../../../apps/indexer/src/util'

const base = { SAVOIRE_INDEXER_NAME: 'idx-a', SAVOIRE_INDEXER_TOKEN: 'x'.repeat(32), SAVOIRE_INDEXER_BACKEND_URL: 'http://backend:8080/' }

describe('configuration', () => {
  it('valeurs par defaut, unites, adresse sans / final', () => {
    const { config, warnings } = loadConfig({ ...base, SAVOIRE_INDEXER_ORPHAN_TTL: '2h', SAVOIRE_INDEXER_MAX_BODY_BYTES: '128KiB' })
    expect(config.backendUrl).toBe('http://backend:8080')
    expect(config.port).toBe(7070)
    expect(config.debounceMs).toBe(1000)
    expect(config.orphanTtlMs).toBe(2 * 3600_000)
    expect(config.maxBodyBytes).toBe(128 * 1024)
    expect(config.metricsAuth).toBe('token')
    expect(warnings).toEqual([])
    expect(parseDuration('24h')).toBe(86_400_000)
    expect(parseDuration('1.5s')).toBe(1500)
    expect(parseDuration('abc')).toBeUndefined()
    expect(parseBytes('32MiB')).toBe(32 * 1024 * 1024)
  })

  it('toutes les erreurs d un coup ; variable inconnue signalee', () => {
    let err: unknown
    try {
      loadConfig({ SAVOIRE_INDEXER_TOKEN: 'court', SAVOIRE_INDEXER_BACKEND_URL: 'ftp://x', SAVOIRE_INDEXER_PORT: 'abc', SAVOIRE_INDEXER_DEBOUNCE_MS: '-5' })
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(ConfigError)
    const problems = (err as ConfigError).problems.join('\n')
    for (const k of ['SAVOIRE_INDEXER_NAME', 'SAVOIRE_INDEXER_TOKEN', 'SAVOIRE_INDEXER_BACKEND_URL', 'SAVOIRE_INDEXER_PORT', 'SAVOIRE_INDEXER_DEBOUNCE_MS']) expect(problems).toContain(k)
    const { warnings } = loadConfig({ ...base, SAVOIRE_INDEXER_DEBOUNCE: '5' })
    expect(warnings.join()).toContain('SAVOIRE_INDEXER_DEBOUNCE')
    expect(() => loadConfig({ ...base, SAVOIRE_INDEXER_DEBOUNCE_MS: '9000', SAVOIRE_INDEXER_DEBOUNCE_MAX_MS: '100' })).toThrow(/DEBOUNCE_MAX_MS/)
  })

  it('jeton lu dans un fichier (secrets Docker)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'idx-cfg-'))
    writeFileSync(join(dir, 'token'), 'y'.repeat(40) + '\n')
    const { config } = loadConfig({ SAVOIRE_INDEXER_NAME: 'a', SAVOIRE_INDEXER_BACKEND_URL: 'http://b', SAVOIRE_INDEXER_TOKEN_FILE: join(dir, 'token') })
    expect(config.token).toBe('y'.repeat(40))
  })

  it('table des variables pour le README', () => {
    const md = settingsTable(true)
    expect(md).toContain('| `SAVOIRE_INDEXER_DEBOUNCE_MS` | `1000` |')
    expect(md.split('\n').length).toBeGreaterThan(30)
  })
})

describe('creneau SQLite : priorites', () => {
  it('appels d abord, puis mises a jour, puis constructions ; annulation avant le tour', async () => {
    const slot = new PrioritySlot()
    const order: string[] = []
    let release!: () => void
    const blocker = slot.run(BUILD, () => new Promise<void>(r => { release = r }))
    const task = (name: string) => async () => { order.push(name) }
    const ps = [
      slot.run(BUILD, task('build-1')),
      slot.run(LIVE, task('live-1')),
      slot.run(INTERACTIVE, task('call-1')),
      slot.run(BUILD, task('build-2')),
      slot.run(INTERACTIVE, task('call-2')),
    ]
    const ac = new AbortController()
    const cancelled = slot.run(INTERACTIVE, task('annule'), ac.signal)
    ac.abort()
    await expect(cancelled).rejects.toBeInstanceOf(SlotAbortedError)
    expect(slot.depth(INTERACTIVE)).toBe(2)
    release()
    await blocker
    await Promise.all(ps)
    expect(order).toEqual(['call-1', 'call-2', 'live-1', 'build-1', 'build-2'])
  })

  it('pas de famine : une mise a jour qui attend trop passe devant les appels', async () => {
    const slot = new PrioritySlot()
    const order: string[] = []
    let release!: () => void
    const blocker = slot.run(INTERACTIVE, () => new Promise<void>(r => { release = r }))
    const live = slot.run(LIVE, async () => { order.push('live') })
    const calls = Array.from({ length: 8 }, (_, i) => slot.run(INTERACTIVE, async () => { order.push(`call-${i}`) }))
    await new Promise(r => setTimeout(r, 600))
    release()
    await Promise.all([blocker, live, ...calls])
    expect(order.indexOf('live')).toBeLessThan(order.length - 1)
  })
})

describe('cache de resultats', () => {
  it('sert la meme generation, oublie a la suivante, expire, borne en taille', () => {
    const c = new ResultCache(3, 1e6, 1000)
    const k = ResultCache.key('v', 'search', 'run', stableStringify({ text: 'a', limit: 5 }))
    expect(ResultCache.key('v', 'search', 'run', stableStringify({ limit: 5, text: 'a' }))).toBe(k)
    c.set(k, 'v', 4, '{"x":1}', 0)
    expect(c.get(k, 4, 10)).toBe('{"x":1}')
    expect(c.get(k, 5, 10)).toBeUndefined()
    c.set(k, 'v', 5, '{"x":2}', 0)
    expect(c.get(k, 5, 2000)).toBeUndefined()
    for (let i = 0; i < 5; i++) c.set(`k${i}`, 'v', 1, '{}', 0)
    expect(c.size).toBe(3)
    c.forgetVault('v')
    expect(c.size).toBe(0)
    expect(c.hits).toBe(1)
  })
})

describe('recherche globale : fusion et curseur compose', () => {
  const hit = (id: string, score: number) => ({ id, path: `${id}.md`, title: id, score, snippets: [] })

  it('par pertinence, puis vault, puis id ; s arrete ou un vault a encore des pages', () => {
    const { hits, remaining } = mergePages([
      { vaultId: 'a', part: { c: null, s: 0 }, hits: [hit('a1', 9), hit('a2', 3)], next: 'ca' },
      { vaultId: 'b', part: { c: null, s: 0 }, hits: [hit('b1', 9), hit('b2', 5), hit('b3', 1)] },
    ], 10)
    expect(hits.map(h => `${h.vaultId}/${h.id}`)).toEqual(['a/a1', 'b/b1', 'b/b2', 'a/a2'])
    // a a epuise sa page mais en a une autre : b3 attend.
    expect(remaining).toEqual({ a: { c: 'ca', s: 0 }, b: { c: null, s: 2 } })
    const cur = encodeCursor(remaining, true)
    expect(decodeCursor(cur)).toEqual({ parts: remaining, partial: true })
    expect(decodeCursor('pas-un-curseur')).toBeNull()
  })

  it('etat le moins avance', () => {
    expect(worstIndex([{ status: 'ready' }, { status: 'building', progress: 0.4 }, { status: 'building', progress: 0.2 }])).toEqual({ status: 'building', progress: 0.2 })
    expect(worstIndex([{ status: 'ready' }, { status: 'lagging', lagMs: 7000 }])).toEqual({ status: 'lagging', lagMs: 7000 })
  })
})

describe('metriques et jeton', () => {
  it('format texte Prometheus : etiquettes echappees, histogramme, quantiles', () => {
    const c = new Counter('x_total', 'aide')
    c.inc({ route: 'a"b' })
    c.inc({ route: 'a"b' }, 2)
    const h = new Histogram('d_seconds', 'duree', [0.1, 1])
    for (const s of [0.05, 0.2, 0.3, 2]) h.observe({ cap: 'query' }, s)
    const text = render([c.family(), ...h.families('d_q', 'quantiles')])
    expect(text).toContain('# TYPE x_total counter')
    expect(text).toContain('x_total{route="a\\"b"} 3')
    expect(text).toContain('d_seconds_bucket{cap="query",le="0.1"} 1')
    expect(text).toContain('d_seconds_bucket{cap="query",le="+Inf"} 4')
    expect(text).toContain('d_seconds_count{cap="query"} 4')
    expect(text).toContain('d_q{cap="query",quantile="0.5"} 0.2')
  })

  it('jeton : comparaison exacte, Bearer obligatoire', () => {
    expect(tokenMatches('Bearer secret-0123456789', 'secret-0123456789')).toBe(true)
    expect(tokenMatches('Bearer secret-012345678', 'secret-0123456789')).toBe(false)
    expect(tokenMatches('secret-0123456789', 'secret-0123456789')).toBe(false)
    expect(tokenMatches(undefined, 'secret-0123456789')).toBe(false)
  })
})
