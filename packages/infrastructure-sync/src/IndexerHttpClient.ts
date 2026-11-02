// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Client HTTP des routes publiques du pair indexeur (ADR-027,
// docs/Architecture/indexer-protocol.md, « Routes publiques ») :
//   POST /api/v1/vaults/{vaultId}/index/{capacite}/{methode}
//   POST /api/v1/search
//   GET|PUT /api/v1/vaults/{vaultId}/indexer
//
// Il ne decide rien : il rend le resultat, ou une IndexerHttpError qui dit
// tout ce que la reponse portait (statut, code, Retry-After, mode, adresse).
// La bascule et les nouveaux essais sont dans RemoteVaultIndexer.
//
// Un 401 renouvelle le jeton et rejoue une fois (fetchWithRenewal). Chaque
// appel a un delai : au-dela, il est abandonne (code 'timeout').
import type { GlobalSearchQuery, SearchResult } from '@savoire/plugin-api'
import type { VaultIndexerSetting, VaultIndexerSettingInput } from '@savoire/application'
import { fetchWithRenewal } from './http'
import { serverUrl } from './serverAddress'

/** Delai d'un appel, cote client. Le backend coupe deja a 5 s (Indexer:TimeoutMs). */
export const INDEXER_CLIENT_TIMEOUT_MS = 10_000

export interface IndexerHttpClientOptions {
  /** Base du serveur ; vide : la base commune (voir serverAddress.ts). */
  baseUrl?: string
  getToken: () => string | null | undefined
  fetchFn?: typeof fetch
  timeoutMs?: number
}

/**
 * Echec d'un appel. `status` 0 : pas de reponse (`code` 'network',
 * 'timeout' ou 'aborted'). Sinon, le code du corps `{ error: { code } }`.
 */
export class IndexerHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    /** Retry-After, en millisecondes. */
    readonly retryAfterMs?: number,
    /** Reglage du vault, rendu avec un 503 (`none`, `organization`). */
    readonly mode?: string,
    /** Adresse du pair d'organisation (503 en mode `organization`). */
    readonly url?: string,
  ) {
    super(message)
    this.name = 'IndexerHttpError'
  }
}

/** Retry-After : un nombre de secondes, ou une date HTTP. */
export function parseRetryAfter(value: string | null | undefined, now: number = Date.now()): number | undefined {
  if (!value) return undefined
  const v = value.trim()
  if (/^\d+$/.test(v)) return Number(v) * 1000
  const at = Date.parse(v)
  return Number.isNaN(at) ? undefined : Math.max(0, at - now)
}

export class IndexerHttpClient {
  private readonly fetchFn: typeof fetch
  private readonly timeoutMs: number

  constructor(private readonly options: IndexerHttpClientOptions) {
    const raw = options.fetchFn ?? globalThis.fetch.bind(globalThis)
    this.fetchFn = ((input: string, init?: RequestInit) => fetchWithRenewal(raw, input, init)) as typeof fetch
    this.timeoutMs = options.timeoutMs ?? INDEXER_CLIENT_TIMEOUT_MS
  }

  /** Appel d'un pouvoir sur un vault. Rend `result`. */
  call<T = unknown>(vaultId: string, capability: string, method: string, params: unknown, signal?: AbortSignal): Promise<T> {
    const path = `/api/v1/vaults/${encodeURIComponent(vaultId)}/index/${encodeURIComponent(capability)}/${encodeURIComponent(method)}`
    return this.request<T>('POST', path, params ?? {}, signal)
  }

  /** Recherche sur plusieurs vaults. */
  searchAll(query: GlobalSearchQuery, signal?: AbortSignal): Promise<SearchResult> {
    return this.request<SearchResult>('POST', '/api/v1/search', query, signal)
  }

  getSetting(vaultId: string, signal?: AbortSignal): Promise<VaultIndexerSetting> {
    return this.request<VaultIndexerSetting>('GET', `/api/v1/vaults/${encodeURIComponent(vaultId)}/indexer`, undefined, signal)
  }

  setSetting(vaultId: string, setting: VaultIndexerSettingInput, signal?: AbortSignal): Promise<VaultIndexerSetting> {
    const body = setting.mode === 'organization' ? { mode: setting.mode, url: setting.url } : { mode: setting.mode }
    return this.request<VaultIndexerSetting>('PUT', `/api/v1/vaults/${encodeURIComponent(vaultId)}/indexer`, body, signal)
  }

  private async request<T>(method: string, path: string, body: unknown, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) throw new IndexerHttpError(0, 'aborted', 'Appel annule.')
    // Delai propre a l'appel, et annulation par l'appelant : un seul signal.
    const ctrl = new AbortController()
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; ctrl.abort() }, this.timeoutMs)
    const onAbort = () => ctrl.abort()
    signal?.addEventListener('abort', onAbort, { once: true })
    const token = this.options.getToken()
    const headers: Record<string, string> = { Accept: 'application/json' }
    if (token) headers.Authorization = `Bearer ${token}`
    if (body !== undefined) headers['Content-Type'] = 'application/json'
    let res: Response
    try {
      res = await this.fetchFn(serverUrl(path, this.options.baseUrl), {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: ctrl.signal,
      })
    } catch (err) {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      if (signal?.aborted) throw new IndexerHttpError(0, 'aborted', 'Appel annule.')
      if (timedOut) throw new IndexerHttpError(0, 'timeout', 'Le pair indexeur n\'a pas repondu a temps.')
      throw new IndexerHttpError(0, 'network', `Serveur injoignable : ${err instanceof Error ? err.message : String(err)}`)
    }
    try {
      const text = await res.text()
      if (res.ok) return (text ? JSON.parse(text) : undefined) as T
      let parsed: { error?: { code?: string; message?: string }; mode?: string; url?: string } = {}
      try { parsed = text ? JSON.parse(text) : {} } catch { /* corps illisible */ }
      throw new IndexerHttpError(
        res.status,
        parsed.error?.code ?? `http_${res.status}`,
        parsed.error?.message ?? `HTTP ${res.status}`,
        parseRetryAfter(res.headers.get('Retry-After')),
        typeof parsed.mode === 'string' ? parsed.mode : undefined,
        typeof parsed.url === 'string' ? parsed.url : undefined,
      )
    } catch (err) {
      if (err instanceof IndexerHttpError) throw err
      if (signal?.aborted) throw new IndexerHttpError(0, 'aborted', 'Appel annule.')
      if (timedOut) throw new IndexerHttpError(0, 'timeout', 'Le pair indexeur n\'a pas repondu a temps.')
      throw new IndexerHttpError(0, 'network', `Reponse illisible : ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
  }
}
