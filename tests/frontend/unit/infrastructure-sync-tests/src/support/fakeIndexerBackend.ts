// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Faux backend des routes publiques du pair indexeur, pour les tests des
// moteurs distants : un `fetch` qui repond comme le backend relaie le pair
// (docs/Architecture/indexer-protocol.md), avec un vrai index par vault
// (indexer-core sur node:sqlite, en memoire). On peut y injecter des refus
// (503, 429, reseau) et compter les appels.
import { IndexError, VaultIndex } from '@savoire/indexer-core'
import { NodeSqliteDriver } from '@savoire/indexer-core/node'
import type { SearchHit, SearchResult } from '@savoire/plugin-api'

export function memoryIndex(): Promise<VaultIndex> {
  return VaultIndex.open(NodeSqliteDriver.open(':memory:'))
}

export interface FakeCall {
  method: string
  path: string
  body: unknown
  auth: string | null
}

/** Reponse forcee : un statut, un corps, des en-tetes ; ou une coupure reseau. */
export type Injected =
  | { status: number; body?: unknown; headers?: Record<string, string> }
  | { network: true }

export interface FakeIndexerBackend {
  fetch: typeof fetch
  calls: FakeCall[]
  /** Les prochaines reponses (dans l'ordre), avant tout traitement. */
  inject(...responses: Injected[]): void
  /** Toutes les reponses, tant que `fn` rend quelque chose. */
  intercept(fn: ((call: FakeCall) => Injected | undefined) | null): void
  /** Jetons acceptes (absent : tous). */
  acceptTokens(tokens: string[] | null): void
  setting: { mode: 'managed' | 'organization' | 'none'; url?: string }
}

function reply(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  const text = body === undefined ? '' : JSON.stringify(body)
  const h = new Headers({ 'content-type': 'application/json', ...headers })
  // Reponse minimale : text() se resout tout de suite (ordre des appels garde).
  return { ok: status >= 200 && status < 300, status, headers: h, text: async () => text } as unknown as Response
}

function errorReply(err: unknown): Response {
  if (err instanceof IndexError) {
    const status = err.code === 'unavailable' ? 503 : /^unknown_/.test(err.code) ? 404 : 400
    return reply(status, { error: { code: err.code, message: err.message } }, status === 503 ? { 'Retry-After': '5' } : {})
  }
  return reply(503, { error: { code: 'unavailable', message: String(err) } }, { 'Retry-After': '5' })
}

export function fakeIndexerBackend(vaults: Record<string, VaultIndex>): FakeIndexerBackend {
  const calls: FakeCall[] = []
  const queue: Injected[] = []
  let interceptor: ((call: FakeCall) => Injected | undefined) | null = null
  let tokens: string[] | null = null
  const backend: FakeIndexerBackend = {
    calls,
    setting: { mode: 'managed' },
    inject: (...r) => { queue.push(...r) },
    intercept: fn => { interceptor = fn },
    acceptTokens: t => { tokens = t },
    fetch: ((input: string, init: RequestInit = {}) => {
      const url = new URL(String(input), 'http://savoire.test')
      const headers = new Headers(init.headers)
      const call: FakeCall = {
        method: init.method ?? 'GET',
        path: url.pathname,
        body: typeof init.body === 'string' && init.body ? JSON.parse(init.body) : undefined,
        auth: headers.get('Authorization'),
      }
      calls.push(call)
      if (init.signal?.aborted) return Promise.reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
      const forced = queue.shift() ?? interceptor?.(call)
      if (forced) {
        if ('network' in forced) return Promise.reject(new TypeError('fetch failed'))
        return Promise.resolve(reply(forced.status, forced.body, forced.headers))
      }
      if (tokens && !tokens.includes((call.auth ?? '').replace(/^Bearer /, ''))) {
        return Promise.resolve(reply(401, { error: { code: 'unauthorized', message: 'jeton refuse' } }))
      }
      // Les appels au pair partent tout de suite (avant tout await) : l'ordre
      // des operations sur l'index est celui des envois.
      const m = /^\/api\/v1\/vaults\/([^/]+)\/index\/([^/]+)\/([^/]+)$/.exec(url.pathname)
      if (m && call.method === 'POST') {
        const index = vaults[decodeURIComponent(m[1])]
        if (!index) return Promise.resolve(reply(404, { error: { code: 'not_found', message: 'vault inconnu' } }))
        if (backend.setting.mode === 'none') return Promise.resolve(reply(503, { error: { code: 'unavailable', message: 'aucun pair' }, mode: 'none' }, { 'Retry-After': '5' }))
        if (backend.setting.mode === 'organization') return Promise.resolve(reply(503, { error: { code: 'unavailable', message: 'pair de l organisation' }, mode: 'organization', url: backend.setting.url }))
        return index.call(m[2], m[3], call.body ?? {}).then(r => reply(200, r), errorReply)
      }
      if (url.pathname === '/api/v1/search' && call.method === 'POST') {
        const { vaultIds, cursor: _cursor, ...query } = (call.body ?? {}) as { vaultIds?: string[]; cursor?: string; text: string }
        const ids = Object.keys(vaults).filter(id => !vaultIds || vaultIds.includes(id))
        return Promise.all(ids.map(id => vaults[id].call('search', 'run', query).then(
          r => ({ id, r: r as SearchResult }),
        ))).then(results => {
          const hits: SearchHit[] = results.flatMap(({ id, r }) => r.hits.map(h => ({ ...h, vaultId: id })))
          hits.sort((a, b) => b.score - a.score || (a.vaultId! < b.vaultId! ? -1 : a.vaultId! > b.vaultId! ? 1 : 0) || (a.id < b.id ? -1 : 1))
          const total = results.reduce((n, { r }) => n + r.total, 0)
          return reply(200, { hits, total, index: { status: 'ready' } } satisfies SearchResult)
        }, errorReply)
      }
      const s = /^\/api\/v1\/vaults\/([^/]+)\/indexer$/.exec(url.pathname)
      if (s && call.method === 'GET') {
        return Promise.resolve(reply(200, backend.setting.mode === 'organization'
          ? { mode: 'organization', url: backend.setting.url }
          : { mode: backend.setting.mode, state: { status: backend.setting.mode === 'managed' ? 'ready' : 'unavailable' } }))
      }
      if (s && call.method === 'PUT') {
        const body = call.body as { mode: 'managed' | 'organization' | 'none'; url?: string }
        backend.setting = body.mode === 'organization' ? { mode: body.mode, url: body.url } : { mode: body.mode }
        return Promise.resolve(reply(200, backend.setting))
      }
      return Promise.resolve(reply(404, { error: { code: 'not_found', message: url.pathname } }))
    }) as unknown as typeof fetch,
  }
  return backend
}
