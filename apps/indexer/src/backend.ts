// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Client de l'API interne du backend (indexer-protocol.md, « API interne ») :
// liste des vaults de l'instance, flux de changements, journaux Yjs de
// l'arbre, des documents et des reglages du vault (types des proprietes). Lecture seule, jeton de service.
//
//  - delai par appel, annulation (AbortSignal) ;
//  - nouveaux essais avec attente croissante sur erreur reseau, delai depasse
//    et 5xx (lectures : sans effet de bord) ; jamais sur 4xx ;
//  - taille de reponse bornee (lecture en flux, coupee au-dela) ;
//  - 404 d'un journal : null (vault ou document parti).
import type { Counter, Histogram } from './metrics'
import { sleep } from './util'

export interface BackendOptions {
  url: string
  token: string
  name: string
  timeoutMs: number
  retries: number
  maxBytes: number
  userAgent: string
}

export interface FeedChange {
  seq: number
  vaultId: string
  kind: 'vault' | 'document' | 'vault-deleted' | string
  docId?: string | null
}

export interface FeedPage {
  changes: FeedChange[]
  last: number
  epoch: string
}

export interface UpdatesLog {
  updates: string[]
  format: 'yjs' | 'json' | string
}

export class BackendError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    /** Vaut la peine de reessayer (reseau, delai, 5xx). */
    readonly transient: boolean,
  ) {
    super(message)
    this.name = 'BackendError'
  }
}

export interface BackendMetrics {
  requests: Counter
  duration: Histogram
}

type Route = 'vaults' | 'changes' | 'tree' | 'document' | 'settings'

export class BackendClient {
  constructor(
    private readonly opts: BackendOptions,
    private readonly metrics?: BackendMetrics,
  ) {}

  async vaults(signal?: AbortSignal): Promise<{ vaultId: string; name?: string }[]> {
    const body = await this.get('vaults', `/internal/indexer/vaults?instance=${encodeURIComponent(this.opts.name)}`, signal)
    const list = (body as { vaults?: unknown })?.vaults
    if (!Array.isArray(list)) throw new BackendError(502, 'malformed', 'Reponse illisible (vaults).', true)
    return list.filter((v): v is { vaultId: string; name?: string } => typeof (v as { vaultId?: unknown })?.vaultId === 'string')
  }

  async changes(since: number, limit: number, signal?: AbortSignal): Promise<FeedPage> {
    const body = await this.get('changes',
      `/internal/indexer/changes?instance=${encodeURIComponent(this.opts.name)}&since=${since}&limit=${limit}`, signal) as Partial<FeedPage>
    if (!body || !Array.isArray(body.changes) || typeof body.last !== 'number' || typeof body.epoch !== 'string') {
      throw new BackendError(502, 'malformed', 'Reponse illisible (changes).', true)
    }
    return { changes: body.changes, last: body.last, epoch: body.epoch }
  }

  /** Journal de l'arbre du vault ; null si le vault n'existe pas ou n'est plus servi. */
  tree(vaultId: string, signal?: AbortSignal): Promise<UpdatesLog | null> {
    return this.log('tree', `/internal/indexer/vaults/${encodeURIComponent(vaultId)}/tree`, signal)
  }

  /** Journal d'un document ; null s'il n'est pas (ou plus) inscrit dans ce vault. */
  document(vaultId: string, docId: string, signal?: AbortSignal): Promise<UpdatesLog | null> {
    return this.log('document', `/internal/indexer/vaults/${encodeURIComponent(vaultId)}/documents/${encodeURIComponent(docId)}`, signal)
  }

  /**
   * Journal d'une section des reglages du vault (canal « settings/<section> ») ;
   * null si le vault n'est pas servi, ou si le backend ne connait pas cette
   * route (version plus ancienne).
   */
  settings(vaultId: string, section: string, signal?: AbortSignal): Promise<UpdatesLog | null> {
    return this.log('settings', `/internal/indexer/vaults/${encodeURIComponent(vaultId)}/settings/${encodeURIComponent(section)}`, signal)
  }

  private async log(route: Route, path: string, signal?: AbortSignal): Promise<UpdatesLog | null> {
    try {
      const body = await this.get(route, path, signal) as Partial<UpdatesLog>
      if (!body || !Array.isArray(body.updates) || typeof body.format !== 'string') {
        throw new BackendError(502, 'malformed', `Reponse illisible (${route}).`, true)
      }
      return { updates: body.updates.filter((u): u is string => typeof u === 'string'), format: body.format }
    } catch (err) {
      if (err instanceof BackendError && err.status === 404) return null
      throw err
    }
  }

  private async get(route: Route, path: string, signal?: AbortSignal): Promise<unknown> {
    let attempt = 0
    for (;;) {
      try {
        return await this.once(route, path, signal)
      } catch (err) {
        const transient = err instanceof BackendError ? err.transient : false
        if (!transient || attempt >= this.opts.retries || signal?.aborted) throw err
        attempt++
        // 200 ms, 400 ms, 800 ms... (au plus 5 s), un peu de hasard pour ne pas synchroniser les instances.
        await sleep(Math.min(5000, 200 * 2 ** (attempt - 1)) * (0.75 + Math.random() * 0.5), signal)
      }
    }
  }

  private async once(route: Route, path: string, signal?: AbortSignal): Promise<unknown> {
    const t0 = performance.now()
    const timeout = AbortSignal.timeout(this.opts.timeoutMs)
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout
    let status = 0
    try {
      const res = await fetch(this.opts.url + path, {
        headers: { authorization: `Bearer ${this.opts.token}`, accept: 'application/json', 'user-agent': this.opts.userAgent },
        signal: combined,
      })
      status = res.status
      const text = await readCapped(res, this.opts.maxBytes)
      if (res.status === 200) {
        try {
          return JSON.parse(text)
        } catch {
          throw new BackendError(502, 'malformed', `Reponse illisible (${route}).`, true)
        }
      }
      let code = 'http_' + res.status
      let message = `Le backend a repondu ${res.status}.`
      try {
        const e = (JSON.parse(text) as { error?: { code?: unknown; message?: unknown } }).error
        if (typeof e?.code === 'string') code = e.code
        if (typeof e?.message === 'string') message = e.message
      } catch { /* corps non JSON */ }
      throw new BackendError(res.status, code, message, res.status >= 500 || res.status === 429)
    } catch (err) {
      if (err instanceof BackendError) throw err
      if (signal?.aborted) throw err
      if (timeout.aborted) {
        status = -1
        throw new BackendError(504, 'timeout', `Le backend n'a pas repondu en ${this.opts.timeoutMs} ms (${route}).`, true)
      }
      status = -2
      throw new BackendError(502, 'unreachable', `Backend injoignable (${route}) : ${(err as Error).message}`, true)
    } finally {
      const label = status === -1 ? 'timeout' : status === -2 ? 'error' : String(status || 'aborted')
      this.metrics?.requests.inc({ route, status: label })
      this.metrics?.duration.observe({ route }, (performance.now() - t0) / 1000)
    }
  }
}

/** Lit le corps, en coupant au-dela de max octets. */
async function readCapped(res: Response, max: number): Promise<string> {
  const len = Number(res.headers.get('content-length') ?? NaN)
  if (Number.isFinite(len) && len > max) {
    await res.body?.cancel().catch(() => undefined)
    throw new BackendError(413, 'too_large', `Reponse de ${len} octets, au-dela de ${max}.`, false)
  }
  if (!res.body) return ''
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > max) {
      await reader.cancel().catch(() => undefined)
      throw new BackendError(413, 'too_large', `Reponse au-dela de ${max} octets.`, false)
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks, total).toString('utf8')
}
