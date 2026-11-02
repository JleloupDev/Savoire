// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Le pair indexeur : serveur HTTP (API du pair, indexer-protocol.md), suivi
// du flux, fils d'indexation, cache, metriques, arret propre.
//
// Routes :
//   POST /v1/vaults/{id}/call     { capability, method, params, caller } -> { result }
//   POST /v1/search               { vaultIds, query, caller } -> SearchResult
//   GET  /v1/vaults/{id}/status   -> IndexState + { seq, docs, bytes }
//   GET  /health/live, /health/ready, /metrics
// Jeton de service obligatoire (sauf sante ; /metrics selon METRICS_AUTH).
import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { monitorEventLoopDelay } from 'node:perf_hooks'
import type { IntervalHistogram } from 'node:perf_hooks'
import type { IndexPower } from '@savoire/indexer-core'
import { QUERY_DEFAULT_LIMIT, QUERY_MAX_LIMIT } from '@savoire/plugin-api'
import type { IndexState, SearchHit, SearchResult } from '@savoire/plugin-api'
import { BackendClient } from './backend'
import { ResultCache } from './cache'
import type { IndexerConfig } from './config'
import { HttpError, notOwner, unavailable } from './errors'
import { Feed } from './feed'
import { decodeCursor, encodeCursor, mergePages, worstIndex } from './globalSearch'
import type { Part, VaultPage } from './globalSearch'
import { parseJson, readBody, sendError, sendJson, sendText, tokenMatches } from './http'
import type { Logger } from './log'
import { Counter, Histogram, counterFamily, gauge, render } from './metrics'
import type { Family } from './metrics'
import { ShardPool } from './shards'
import type { StoreSnapshot } from './store'
import { isName, isVaultId, mapLimit, stableStringify } from './util'

export interface ServiceOptions {
  config: IndexerConfig
  log: Logger
  version: string
  /** Fichier a lancer dans chaque Worker (le paquet construit) ; requis si config.workers > 0. */
  workerFile?: string
  /** Tests : pouvoirs modifies. */
  powers?: () => IndexPower[]
}

const LOCK_FILE = '.lock'

export class IndexerService {
  private server?: Server
  private pool?: ShardPool
  private feed?: Feed
  private readonly cache: ResultCache
  private stopping = false
  private stopped?: Promise<void>
  private readonly startedAt = Date.now()
  private inflight = 0
  private loopDelay?: IntervalHistogram
  private readonly m = {
    calls: new Counter('savoire_indexer_calls_total', 'Appels recus, par capacite, methode et statut HTTP.'),
    callSeconds: new Histogram('savoire_indexer_call_duration_seconds', 'Duree des appels (attente comprise), par capacite.'),
    http: new Counter('savoire_indexer_http_requests_total', 'Requetes HTTP, par route et statut.'),
    rejected: new Counter('savoire_indexer_rejected_total', 'Appels refuses, par raison (overloaded, timeout, stopping, not_owner, unauthorized).'),
    polls: new Counter('savoire_indexer_feed_polls_total', 'Lectures du flux, par resultat.'),
    epochs: new Counter('savoire_indexer_epoch_changes_total', 'Changements d\'epoque du flux (reconstruction totale).'),
    backendRequests: new Counter('savoire_indexer_backend_requests_total', 'Appels au backend, par route et statut.'),
    backendSeconds: new Histogram('savoire_indexer_backend_request_duration_seconds', 'Duree des appels au backend, par route.'),
  }

  constructor(private readonly opts: ServiceOptions) {
    const c = opts.config
    this.cache = new ResultCache(c.cacheEntries, c.cacheMaxBytes, c.cacheTtlMs)
  }

  get port(): number {
    const a = this.server?.address()
    return typeof a === 'object' && a ? a.port : 0
  }

  async start(): Promise<void> {
    const c = this.opts.config
    const log = this.opts.log
    mkdirSync(c.dataDir, { recursive: true })
    this.lock()
    this.loopDelay = monitorEventLoopDelay({ resolution: 20 })
    this.loopDelay.enable()

    const workers = c.workers > 0
    this.pool = new ShardPool({
      count: Math.max(1, c.workers),
      workers,
      workerFile: this.opts.workerFile,
      init: { config: c, version: this.opts.version },
      maxQueue: c.maxQueue,
      retryAfterS: c.retryAfterS,
      unavailableRetryAfterS: c.unavailableRetryAfterS,
      log,
      onRestart: i => this.onShardRestart(i),
      ...(this.opts.powers ? { powers: this.opts.powers } : {}),
    })
    const backend = new BackendClient({
      url: c.backendUrl, token: c.token, name: c.name, timeoutMs: c.backendTimeoutMs, retries: c.backendRetries,
      maxBytes: c.maxDocBytes, userAgent: `savoire-indexer/${this.opts.version}`,
    }, { requests: this.m.backendRequests, duration: this.m.backendSeconds })
    this.feed = new Feed({
      name: c.name, dataDir: c.dataDir, feedLimit: c.feedLimit, feedActiveMs: c.feedActiveMs, feedIdleMs: c.feedIdleMs,
      feedStaleMs: c.feedStaleMs, vaultsRefreshMs: c.vaultsRefreshMs,
    }, backend, this.pool, log.child({ part: 'feed' }), { polls: this.m.polls, epochs: this.m.epochs })

    this.server = createServer({ keepAliveTimeout: 65_000, requestTimeout: 60_000, headersTimeout: 15_000 }, (req, res) => {
      this.route(req, res).catch(err => {
        log.error('requete en echec', { err })
        if (!res.headersSent) sendError(res, new HttpError(500, 'internal', 'Erreur interne du pair indexeur.'))
      })
    })
    this.server.maxRequestsPerSocket = 0
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject)
      this.server!.listen(c.port, c.host, () => { this.server!.off('error', reject); resolve() })
    })
    this.feed.start()
    log.info('pair indexeur demarre', { port: this.port, host: c.host, workers: this.pool.count, threads: workers ? 'worker_threads' : 'principal', dataDir: c.dataDir })
  }

  /** Arret propre : plus d'appel, ecritures finies, fichiers fermes, position ecrite. */
  stop(reason = 'arret'): Promise<void> {
    this.stopped ??= (async () => {
      const c = this.opts.config
      const log = this.opts.log
      this.stopping = true
      log.info('arret du pair indexeur', { reason })
      const deadline = Date.now() + c.shutdownTimeoutMs
      const closing = new Promise<void>(resolve => this.server ? this.server.close(() => resolve()) : resolve())
      this.server?.closeIdleConnections()
      while (this.inflight > 0 && Date.now() < deadline) await new Promise(r => setTimeout(r, 20))
      this.server?.closeAllConnections()
      await closing
      await this.feed?.stop()
      await this.pool?.stop(Math.max(100, deadline - Date.now()))
      // Position finale, une fois les fils arretes (ils ne la font plus bouger).
      this.loopDelay?.disable()
      this.unlock()
      log.info('pair indexeur arrete', { reason })
    })()
    return this.stopped
  }

  // ── Verrou du dossier ────────────────────────────────────────────────────

  private lock(): void {
    const file = join(this.opts.config.dataDir, LOCK_FILE)
    try {
      const other = JSON.parse(readFileSync(file, 'utf8')) as { pid?: number }
      if (other.pid && other.pid !== process.pid && alive(other.pid)) {
        throw new Error(`Le dossier ${this.opts.config.dataDir} est deja utilise par le processus ${other.pid}. Un dossier (un volume) par instance.`)
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT' && !(err instanceof SyntaxError)) throw err
    }
    writeFileSync(file, JSON.stringify({ pid: process.pid, name: this.opts.config.name, since: new Date().toISOString() }))
  }

  private unlock(): void {
    rmSync(join(this.opts.config.dataDir, LOCK_FILE), { force: true })
  }

  private onShardRestart(i: number): void {
    const feed = this.feed!
    if (feed.epoch !== undefined) this.pool!.send(i, { t: 'epoch', epoch: feed.epoch, changed: false })
    this.pool!.own([...feed.owned].filter(id => this.pool!.shardOf(id) === i), true)
    feed.rewind()
  }

  // ── Routes ───────────────────────────────────────────────────────────────

  private async route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://pair')
    const path = url.pathname
    let route = 'other'
    res.on('finish', () => this.m.http.inc({ route, status: res.statusCode }))
    const c = this.opts.config

    if (path === '/health/live') {
      route = 'live'
      return sendJson(res, 200, JSON.stringify({ status: 'live', uptimeSeconds: Math.round((Date.now() - this.startedAt) / 1000) }))
    }
    if (path === '/health/ready') {
      route = 'ready'
      const r = this.readiness()
      return sendJson(res, r.ready ? 200 : 503, JSON.stringify(r))
    }
    if (path === '/metrics') {
      route = 'metrics'
      if (c.metricsAuth === 'token' && !tokenMatches(req.headers.authorization, c.token)) return this.unauthorized(res)
      return sendText(res, 200, await this.metrics(), 'text/plain; version=0.0.4; charset=utf-8')
    }

    const call = /^\/v1\/vaults\/([^/]+)\/(call|status)$/.exec(path)
    const isSearch = path === '/v1/search'
    if (!call && !isSearch) return sendError(res, new HttpError(404, 'not_found', 'Route inconnue.'))
    route = isSearch ? 'search' : call![2]!
    const method = route === 'status' ? 'GET' : 'POST'
    if (req.method !== method) return sendError(res, new HttpError(405, 'method_not_allowed', `${method} attendu.`))
    if (!tokenMatches(req.headers.authorization, c.token)) return this.unauthorized(res)

    this.inflight++
    const ac = new AbortController()
    res.on('close', () => { if (!res.writableFinished) ac.abort() })
    try {
      if (this.stopping) throw this.reject('stopping', unavailable('Le pair indexeur s\'arrete.', c.unavailableRetryAfterS))
      if (!this.feed?.listed) throw this.reject('starting', unavailable('Le pair indexeur demarre.', c.unavailableRetryAfterS))
      if (isSearch) return await this.search(req, res, ac.signal)
      let vaultId: string
      try { vaultId = decodeURIComponent(call![1]!) } catch { vaultId = '' }
      if (!isVaultId(vaultId)) throw new HttpError(400, 'invalid_query', 'Id de vault invalide.')
      if (route === 'status') {
        const json = await this.callCached(vaultId, 'index', 'status', {}, ac.signal)
        return sendJson(res, 200, json)
      }
      const body = parseJson(await readBody(req, c.maxBodyBytes)) as { capability?: unknown; method?: unknown; params?: unknown }
      if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new HttpError(400, 'invalid_query', 'Corps : objet attendu.')
      if (!isName(body.capability) || !isName(body.method)) throw new HttpError(400, 'invalid_query', 'capability et method : ^[a-z][a-z0-9_-]{0,63}$.')
      const json = await this.callCached(vaultId, body.capability, body.method, body.params ?? {}, ac.signal)
      sendJson(res, 200, `{"result":${json}}`)
    } catch (err) {
      sendError(res, err instanceof HttpError ? err : this.internal(err))
    } finally {
      this.inflight--
    }
  }

  private unauthorized(res: ServerResponse): void {
    this.m.rejected.inc({ reason: 'unauthorized' })
    sendError(res, new HttpError(401, 'unauthorized', 'Jeton de service absent ou invalide.'))
  }

  private reject(reason: string, err: HttpError): HttpError {
    this.m.rejected.inc({ reason })
    return err
  }

  private internal(err: unknown): HttpError {
    this.opts.log.error('erreur interne', { err })
    return new HttpError(500, 'internal', 'Erreur interne du pair indexeur.')
  }

  /** Un appel, servi par le cache s'il a deja ete fait sur cette generation de l'index. */
  private async callCached(vaultId: string, capability: string, method: string, params: unknown, signal: AbortSignal, timeoutMs = this.opts.config.callTimeoutMs): Promise<string> {
    const c = this.opts.config
    const pool = this.pool!
    const feed = this.feed!
    const t0 = performance.now()
    let status = 200
    try {
      if (!feed.owned.has(vaultId) && !(await feed.ensureOwned(vaultId, 2000))) {
        throw this.reject('not_owner', notOwner(vaultId))
      }
      // Flux non suivi : l'etat rendu (« en retard ») change sans que l'index bouge, pas de cache.
      const useCache = feed.following
      const key = ResultCache.key(vaultId, capability, method, stableStringify(params))
      const hit = useCache ? this.cache.get(key, pool.gens.get(vaultId)) : undefined
      if (hit !== undefined) return hit
      let r: { result: unknown; gen: number }
      try {
        r = await pool.call(vaultId, capability, method, params, timeoutMs, signal)
      } catch (err) {
        if (err instanceof HttpError && err.status === 429) this.m.rejected.inc({ reason: 'overloaded' })
        else if (err instanceof HttpError && err.status === 503) this.m.rejected.inc({ reason: 'timeout' })
        throw err
      }
      const json = JSON.stringify(r.result ?? null)
      if (useCache) this.cache.set(key, vaultId, r.gen, json)
      return json
    } catch (err) {
      status = err instanceof HttpError ? err.status : 500
      throw err
    } finally {
      const seconds = (performance.now() - t0) / 1000
      this.m.calls.inc({ capability, method, status })
      this.m.callSeconds.observe({ capability }, seconds)
      if (seconds * 1000 > c.slowCallMs) this.opts.log.warn('appel lent', { vault: vaultId, capability, method, status, ms: Math.round(seconds * 1000) })
      else if (this.opts.log.enabled('debug')) this.opts.log.debug('appel', { vault: vaultId, capability, method, status, ms: Math.round(seconds * 1000) })
    }
  }

  // ── Recherche globale ────────────────────────────────────────────────────

  private async search(req: IncomingMessage, res: ServerResponse, signal: AbortSignal): Promise<void> {
    const c = this.opts.config
    const t0 = Date.now()
    const body = parseJson(await readBody(req, c.maxBodyBytes)) as { vaultIds?: unknown; query?: unknown }
    if (typeof body !== 'object' || body === null || !Array.isArray(body.vaultIds)) throw new HttpError(400, 'invalid_query', 'vaultIds : liste attendue.')
    if (typeof body.query !== 'object' || body.query === null || Array.isArray(body.query)) throw new HttpError(400, 'invalid_query', 'query : objet attendu.')
    const ids = [...new Set(body.vaultIds)]
    if (!ids.every(isVaultId)) throw new HttpError(400, 'invalid_query', 'vaultIds : ids de vault invalides.')
    if (ids.length > c.searchMaxVaults) throw new HttpError(400, 'too_complex', `${c.searchMaxVaults} vaults au plus.`)
    const query = { ...(body.query as Record<string, unknown>) }
    const limit = query['limit'] === undefined ? QUERY_DEFAULT_LIMIT : query['limit']
    if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > QUERY_MAX_LIMIT) {
      throw new HttpError(400, 'invalid_query', `limit : entier de 1 a ${QUERY_MAX_LIMIT}.`)
    }
    let parts: [string, Part][]
    let partial = false
    if (query['cursor'] !== undefined) {
      const decoded = typeof query['cursor'] === 'string' ? decodeCursor(query['cursor']) : null
      if (!decoded) throw new HttpError(400, 'invalid_cursor', 'Curseur illisible.')
      const wanted = new Set(ids)
      parts = Object.entries(decoded.parts).filter(([id]) => wanted.has(id))
      partial = decoded.partial
    } else {
      parts = ids.map(id => [id, { c: null, s: 0 }])
    }
    delete query['cursor']
    delete query['vaultIds']

    let refused: HttpError | undefined
    let failures = 0
    let overloaded: HttpError | undefined
    const results = await mapLimit(parts, c.searchParallelism, async ([vaultId, part]) => {
      if (refused) return null
      const left = c.callTimeoutMs - (Date.now() - t0)
      if (left <= 0) { failures++; return null }
      try {
        const params = { ...query, limit, ...(part.c ? { cursor: part.c } : {}) }
        const r = JSON.parse(await this.callCached(vaultId, 'search', 'run', params, signal, left)) as SearchResult
        return { vaultId, part, r }
      } catch (err) {
        if (err instanceof HttpError && err.status === 400) { refused ??= err; return null }
        if (err instanceof HttpError && err.status === 429) overloaded = err
        failures++
        return null
      }
    })
    if (refused) throw refused
    const ok = results.filter((x): x is { vaultId: string; part: Part; r: SearchResult } => x !== null)
    if (parts.length && !ok.length) throw overloaded ?? unavailable('Aucun vault n\'a pu repondre.', c.unavailableRetryAfterS)
    if (failures) partial = true
    const pages: VaultPage[] = ok.map(x => ({ vaultId: x.vaultId, part: x.part, hits: x.r.hits as SearchHit[], ...(x.r.next ? { next: x.r.next } : {}) }))
    const { hits, remaining } = mergePages(pages, limit)
    const index: IndexState = worstIndex(ok.map(x => x.r.index))
    const result: SearchResult = {
      hits,
      total: ok.reduce((n, x) => n + (x.r.total ?? 0), 0),
      index,
      ...(Object.keys(remaining).length ? { next: encodeCursor(remaining, partial) } : {}),
      ...(partial ? { partial: true } : {}),
    }
    sendJson(res, 200, JSON.stringify(result))
  }

  // ── Sante et metriques ───────────────────────────────────────────────────

  readiness(): { ready: boolean; following: boolean; shards: boolean; queue: boolean; stopping: boolean; listed: boolean; catchingUp: boolean } {
    const pool = this.pool
    const feed = this.feed
    const cap = pool?.perShardQueue ?? 1
    const queue = !!pool && pool.inflight().every(n => n < cap * 0.9)
    const following = !!feed?.following
    const shards = !!pool?.alive
    return {
      ready: following && shards && queue && !this.stopping,
      following, shards, queue, stopping: this.stopping, listed: !!feed?.listed, catchingUp: !!feed?.catchingUp,
    }
  }

  private async metrics(): Promise<string> {
    const c = this.opts.config
    const pool = this.pool!
    const feed = this.feed!
    const now = Date.now()
    const snaps = (await pool.snapshots()).filter((s): s is StoreSnapshot => s !== null)
    const families: Family[] = []
    const mem = process.memoryUsage()
    const ready = this.readiness()
    families.push(
      gauge('savoire_indexer_info', 'Version et nom de l\'instance.', [{ labels: { version: this.opts.version, name: c.name, node: process.version }, value: 1 }]),
      gauge('savoire_indexer_ready', 'Pret (flux suivi, fils vivants, file non saturee).', [{ value: ready.ready ? 1 : 0 }]),
      gauge('savoire_indexer_uptime_seconds', 'Duree de fonctionnement.', [{ value: Math.round((now - this.startedAt) / 1000) }]),
      gauge('savoire_indexer_feed_cursor', 'Position atteinte dans le flux de changements.', [{ value: feed.cursor }]),
      gauge('savoire_indexer_feed_persisted_cursor', 'Position sure ecrite sur disque (reprise).', [{ value: feed.persisted }]),
      gauge('savoire_indexer_feed_last_success_age_seconds', 'Age de la derniere lecture reussie du flux.', [{ value: feed.lastOkAt ? (now - feed.lastOkAt) / 1000 : -1 }]),
      gauge('savoire_indexer_feed_catching_up', 'Rattrapage du flux en cours (pages pleines).', [{ value: feed.catchingUp ? 1 : 0 }]),
      gauge('savoire_indexer_owned_vaults', 'Vaults que possede l\'instance (liste du backend et flux).', [{ value: feed.owned.size }]),
      this.m.polls.family(), this.m.epochs.family(), this.m.calls.family(), this.m.http.family(), this.m.rejected.family(),
      ...this.m.callSeconds.families('savoire_indexer_call_latency_seconds', 'Latence des appels par capacite (quantiles, 5 dernieres minutes).'),
      gauge('savoire_indexer_inflight_calls', 'Appels en cours ou en attente, par fil.', pool.inflight().map((n, shard) => ({ labels: { shard }, value: n }))),
      gauge('savoire_indexer_queue_capacity', 'Appels admis par fil avant 429.', [{ value: pool.perShardQueue }]),
      gauge('savoire_indexer_queue_depth', 'Taches en attente du creneau SQLite, par fil et priorite.',
        snaps.flatMap(s => Object.entries(s.queue).map(([priority, n]) => ({ labels: { shard: s.shard, priority }, value: n })))),
      gauge('savoire_indexer_open_files', 'Fichiers SQLite ouverts, par fil.', snaps.map(s => ({ labels: { shard: s.shard }, value: s.open }))),
      gauge('savoire_indexer_builds_running', 'Constructions en cours, par fil.', snaps.map(s => ({ labels: { shard: s.shard }, value: s.building }))),
      gauge('savoire_indexer_builds_queued', 'Constructions en attente, par fil.', snaps.map(s => ({ labels: { shard: s.shard }, value: s.buildQueued }))),
      gauge('savoire_indexer_shard_heap_used_bytes', 'Tas JavaScript utilise, par fil.', snaps.filter(s => s.heapUsed !== undefined).map(s => ({ labels: { shard: s.shard }, value: s.heapUsed! }))),
      counterFamily('savoire_indexer_shard_restarts_total', 'Fils d\'indexation tombes et relances.', [{ value: pool.crashes }]),
      counterFamily('savoire_indexer_cache_hits_total', 'Resultats servis par le cache.', [{ value: this.cache.hits }]),
      counterFamily('savoire_indexer_cache_misses_total', 'Resultats absents du cache (ou perimes).', [{ value: this.cache.misses }]),
      counterFamily('savoire_indexer_cache_evictions_total', 'Entrees chassees du cache (taille).', [{ value: this.cache.evictions }]),
      gauge('savoire_indexer_cache_entries', 'Entrees du cache.', [{ value: this.cache.size }]),
      gauge('savoire_indexer_cache_bytes', 'Taille du cache (approximative).', [{ value: this.cache.sizeBytes }]),
      gauge('savoire_indexer_process_resident_memory_bytes', 'Memoire residente du processus (tous fils).', [{ value: mem.rss }]),
      gauge('savoire_indexer_process_heap_used_bytes', 'Tas JavaScript du fil principal.', [{ value: mem.heapUsed }]),
      gauge('savoire_indexer_process_external_memory_bytes', 'Memoire hors tas (tampons...) du fil principal.', [{ value: mem.external + mem.arrayBuffers }]),
    )
    if (this.loopDelay) {
      const h = this.loopDelay
      families.push(gauge('savoire_indexer_event_loop_delay_seconds', 'Retard de la boucle d\'evenements du fil principal depuis la mesure precedente.', [
        { labels: { quantile: '0.5' }, value: h.percentile(50) / 1e9 },
        { labels: { quantile: '0.99' }, value: h.percentile(99) / 1e9 },
        { labels: { quantile: '1' }, value: h.max / 1e9 },
      ]))
      h.reset()
    }
    families.push(this.m.backendRequests.family())
    families.push(...this.m.backendSeconds.families('savoire_indexer_backend_request_latency_seconds', 'Latence des appels au backend (quantiles, 5 dernieres minutes).'))
    for (const f of families) if (f.name.startsWith('savoire_indexer_backend_request')) for (const s of f.samples) s.labels = { ...s.labels, shard: 'main' }

    // Familles des fils : memes noms, etiquette shard.
    for (const s of snaps) {
      for (const f of s.families) {
        const same = families.find(x => x.name === f.name)
        if (same) same.samples.push(...f.samples)
        else families.push(f)
      }
    }

    // Par vault : d'abord ceux en construction ou en retard, puis les plus gros.
    if (c.metricsMaxVaults > 0) {
      const rank = (st: string) => (st === 'building' ? 0 : st === 'lagging' ? 1 : 2)
      const vaults = snaps.flatMap(s => s.vaults).filter(v => !v.orphan)
        .sort((a, b) => rank(a.status) - rank(b.status) || b.bytes - a.bytes || (a.id < b.id ? -1 : 1))
        .slice(0, c.metricsMaxVaults)
      families.push(
        gauge('savoire_indexer_vault_status', 'Etat de l\'index d\'un vault (1 pour l\'etat courant).', vaults.map(v => ({ labels: { vault: v.id, status: v.status }, value: 1 }))),
        gauge('savoire_indexer_vault_build_progress', 'Construction d\'un vault : de 0 a 1 (1 hors construction).', vaults.map(v => ({ labels: { vault: v.id }, value: v.status === 'building' ? v.progress ?? 0 : 1 }))),
        gauge('savoire_indexer_vault_lag_seconds', 'Retard d\'un vault sur le flux (plus vieux changement non traite).', vaults.map(v => ({ labels: { vault: v.id }, value: v.lagMs / 1000 }))),
        gauge('savoire_indexer_vault_pending_changes', 'Changements en attente d\'un vault.', vaults.map(v => ({ labels: { vault: v.id }, value: v.pending }))),
        gauge('savoire_indexer_vault_size_bytes', 'Taille du fichier d\'index d\'un vault (WAL compris).', vaults.map(v => ({ labels: { vault: v.id }, value: v.bytes }))),
        gauge('savoire_indexer_vault_docs', 'Notes indexees d\'un vault.', vaults.map(v => ({ labels: { vault: v.id }, value: v.docs }))),
        gauge('savoire_indexer_vault_seq', 'Derniere sequence du flux traitee pour un vault.', vaults.map(v => ({ labels: { vault: v.id }, value: v.seq }))),
      )
    }
    return render(families)
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}
