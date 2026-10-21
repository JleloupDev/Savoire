// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import { serverUrl } from './serverAddress'

// ── Jeton d'acces refuse (401) : renouveler une fois, rejouer une fois ──────
//
// L'application pose ici, une seule fois, de quoi renouveler le jeton de la
// session (voir apps/web/src/session.ts). Chaque client REST passe par
// fetchWithRenewal : sur un 401, il demande un jeton neuf pour le jeton
// refuse, puis rejoue la requete une seule fois avec le nouveau jeton.

/**
 * Rend un jeton neuf a la place de `rejected`, ou null : pas de session, ce
 * jeton n'est pas celui de la session, ou le renouvellement a echoue.
 */
export type AccessTokenRenewer = (rejected: string) => Promise<string | null>

let renewer: AccessTokenRenewer | null = null

/** Pose la fonction de renouvellement ; null : aucun rejeu. */
export function setAccessTokenRenewer(next: AccessTokenRenewer | null): void {
  renewer = next
}

/** Routes d'authentification : jamais de rejeu (login, refresh, logout...). */
export function isAuthRoute(url: string): boolean {
  return /\/api\/v1\/auth\//.test(url)
}

function bearerOf(headers: HeadersInit | undefined): string | null {
  if (!headers) return null
  let value: string | null | undefined
  if (typeof Headers !== 'undefined' && headers instanceof Headers) value = headers.get('Authorization')
  else if (Array.isArray(headers)) value = headers.find(([k]) => k.toLowerCase() === 'authorization')?.[1]
  else {
    const rec = headers as Record<string, string>
    value = rec.Authorization ?? rec.authorization
  }
  const m = value ? /^Bearer\s+(.+)$/.exec(value) : null
  return m ? m[1] : null
}

function withBearer(headers: HeadersInit | undefined, token: string): HeadersInit {
  if (typeof Headers !== 'undefined' && headers instanceof Headers) {
    const copy = new Headers(headers)
    copy.set('Authorization', `Bearer ${token}`)
    return copy
  }
  if (Array.isArray(headers)) {
    return [...headers.filter(([k]) => k.toLowerCase() !== 'authorization'), ['Authorization', `Bearer ${token}`]]
  }
  const rest = { ...(headers as Record<string, string> | undefined) }
  delete rest.authorization
  return { ...rest, Authorization: `Bearer ${token}` }
}

/**
 * Jeton neuf pour un jeton refuse (401), ou null. Pour les envois qui ne
 * passent pas par fetch (XMLHttpRequest, suivi de progression).
 */
export async function renewRejectedToken(rejected: string): Promise<string | null> {
  if (!renewer) return null
  try {
    const next = await renewer(rejected)
    return next && next !== rejected ? next : null
  } catch {
    return null
  }
}

/**
 * fetch, avec un seul rejeu apres un 401 si un jeton neuf est obtenu. Sans
 * jeton dans la requete, sur une route d'authentification, ou si le
 * renouvellement echoue : la reponse 401 est rendue telle quelle.
 */
export async function fetchWithRenewal(fetchFn: typeof fetch, input: string, init: RequestInit = {}): Promise<Response> {
  const res = await fetchFn(input, init)
  if (res.status !== 401 || !renewer || isAuthRoute(input)) return res
  const rejected = bearerOf(init.headers)
  if (!rejected) return res
  const next = await renewRejectedToken(rejected)
  if (!next) return res
  return fetchFn(input, { ...init, headers: withBearer(init.headers, next) })
}

export interface HttpClientOptions {
  baseUrl?: string
  getToken?: () => string | null | undefined
  fetchFn?: typeof fetch
}

export class HttpClient {
  private readonly baseUrl: string
  private readonly getToken: () => string | null | undefined
  private readonly fetchFn: typeof fetch

  constructor(options: HttpClientOptions = {}) {
    this.baseUrl = options.baseUrl ?? ''
    this.getToken = options.getToken ?? (() => null)
    const raw = options.fetchFn ?? globalThis.fetch.bind(globalThis)
    this.fetchFn = ((input: string, init?: RequestInit) => fetchWithRenewal(raw, input, init)) as typeof fetch
  }

  async getJson<T>(path: string): Promise<T> {
    return this.requestJson<T>(path, { method: 'GET' })
  }

  async postJson<T>(path: string, body: unknown): Promise<T> {
    return this.requestJson<T>(path, { method: 'POST', body: JSON.stringify(body) })
  }

  async patchJson<T>(path: string, body: unknown): Promise<T> {
    return this.requestJson<T>(path, { method: 'PATCH', body: JSON.stringify(body) })
  }

  async putText(path: string, body: string): Promise<void> {
    const headers = this.makeHeaders({ 'Content-Type': 'text/markdown' })
    const res = await this.fetchFn(this.resolve(path), { method: 'PUT', headers, body })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
  }

  async getText(path: string): Promise<string> {
    const res = await this.fetchFn(this.resolve(path), { method: 'GET', headers: this.makeHeaders() })
    if (res.status === 404) return ''
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return res.text()
  }

  async delete(path: string): Promise<void> {
    const res = await this.fetchFn(this.resolve(path), { method: 'DELETE', headers: this.makeHeaders() })
    if (!res.ok && res.status !== 204) throw new Error(`HTTP ${res.status}`)
  }

  private async requestJson<T>(path: string, init: RequestInit): Promise<T> {
    const res = await this.fetchFn(this.resolve(path), {
      ...init,
      headers: this.makeHeaders({ 'Content-Type': 'application/json', ...(init.headers as Record<string, string> | undefined) }),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return res.json() as Promise<T>
  }

  private makeHeaders(extra: Record<string, string> = {}): HeadersInit {
    const token = this.getToken()
    return {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...extra,
    }
  }

  private resolve(path: string): string {
    return serverUrl(path, this.baseUrl)
  }
}
