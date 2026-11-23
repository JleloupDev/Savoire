// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Lecture de l'API de Notion pour l'import (ADR-035).
//
// Le transport est un port : la version bureau le fournit (commande Rust
// notion_api, qui porte le jeton et n'accepte que des lectures). Ce module
// ajoute ce que Notion demande :
//   - le debit : environ 3 requetes par seconde par connexion. On espace les
//     appels (un toutes les 350 ms) et on attend le Retry-After d'un 429 ;
//   - les reprises : 429, 500, 502, 503, 504, 529, jusqu'a 5 essais ;
//   - la pagination : start_cursor / next_cursor, 100 elements par page.

import type { NotionBlock } from './notionBlocks'

export interface NotionHttpReply {
  status: number
  retryAfter?: number | null
  body: string
}

/** Transport vers l'API de Notion (lecture seule). */
export interface NotionApiPort {
  request(method: 'GET' | 'POST', path: string, body?: unknown): Promise<NotionHttpReply>
}

export class NotionApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message)
    this.name = 'NotionApiError'
  }
}

export interface NotionClientOptions {
  /** Delai minimal entre deux appels (ms). */
  intervalMs?: number
  /** Essais au plus pour un appel. */
  attempts?: number
  /** Attente (ms) ; remplace setTimeout dans les tests. */
  sleep?: (ms: number) => Promise<void>
  now?: () => number
}

const RETRY = new Set([429, 500, 502, 503, 504, 529])

/** Un objet de la recherche : page ou source de donnees. */
export interface NotionSearchResult {
  object: 'page' | 'data_source' | 'database'
  id: string
  parent?: { type?: string; page_id?: string; database_id?: string; data_source_id?: string; block_id?: string; workspace?: boolean }
  in_trash?: boolean
  archived?: boolean
  properties?: Record<string, unknown>
  title?: { plain_text?: string }[]
  url?: string
  [key: string]: unknown
}

interface ListReply<T> {
  results?: T[]
  has_more?: boolean
  next_cursor?: string | null
}

export class NotionClient {
  private last = 0
  private readonly intervalMs: number
  private readonly attempts: number
  private readonly sleep: (ms: number) => Promise<void>
  private readonly now: () => number

  constructor(private readonly port: NotionApiPort, options: NotionClientOptions = {}) {
    this.intervalMs = options.intervalMs ?? 350
    this.attempts = options.attempts ?? 5
    this.sleep = options.sleep ?? (ms => new Promise(r => setTimeout(r, ms)))
    this.now = options.now ?? (() => Date.now())
  }

  /** Un appel, au debit permis, avec reprises. Rend le JSON. */
  async call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      const wait = this.last + this.intervalMs - this.now()
      if (wait > 0) await this.sleep(wait)
      this.last = this.now()
      const reply = await this.port.request(method, path, body)
      if (reply.status >= 200 && reply.status < 300) return JSON.parse(reply.body || '{}') as T
      if (RETRY.has(reply.status) && attempt < this.attempts) {
        const seconds = reply.retryAfter ?? Math.min(30, 2 ** attempt)
        await this.sleep(Math.max(1, seconds) * 1000)
        continue
      }
      let code = 'error'
      let message = `Notion a répondu ${reply.status}.`
      try {
        const e = JSON.parse(reply.body) as { code?: string; message?: string }
        if (e.code) code = e.code
        if (e.message) message = e.message
      } catch { /* corps illisible */ }
      throw new NotionApiError(reply.status, code, message)
    }
  }

  /** Toutes les pages d'une liste paginee. */
  private async all<T>(method: 'GET' | 'POST', path: string, body: Record<string, unknown> = {}): Promise<T[]> {
    const out: T[] = []
    let cursor: string | null | undefined
    do {
      const sep = path.includes('?') ? '&' : '?'
      const reply = method === 'GET'
        ? await this.call<ListReply<T>>('GET', `${path}${sep}page_size=100${cursor ? `&start_cursor=${encodeURIComponent(cursor)}` : ''}`)
        : await this.call<ListReply<T>>('POST', path, { ...body, page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) })
      out.push(...(reply.results ?? []))
      cursor = reply.has_more ? reply.next_cursor : null
    } while (cursor)
    return out
  }

  /** Tout ce que l'integration voit : pages et sources de donnees partagees. */
  search(): Promise<NotionSearchResult[]> {
    return this.all<NotionSearchResult>('POST', '/v1/search')
  }

  /** Enfants directs d'un bloc (ou d'une page). */
  blockChildren(id: string): Promise<NotionBlock[]> {
    return this.all<NotionBlock>('GET', `/v1/blocks/${id}/children`)
  }

  /**
   * Les blocs d'une page, enfants compris (un appel par bloc qui en a). Un
   * bloc synchronise copie prend le contenu de son original. `maxDepth`
   * borne la profondeur (les pages tres imbriquees).
   */
  async blockTree(id: string, maxDepth = 12): Promise<NotionBlock[]> {
    const blocks = await this.blockChildren(id)
    if (maxDepth <= 0) return blocks
    for (const b of blocks) {
      // Une sous-page ou une base sont des documents a part : pas leurs enfants ici.
      if (!b.has_children || b.type === 'child_page' || b.type === 'child_database') continue
      const synced = b.type === 'synced_block' ? (b.synced_block as { synced_from?: { block_id?: string } | null } | undefined)?.synced_from?.block_id : undefined
      try {
        b.children = await this.blockTree(synced ?? b.id, maxDepth - 1)
      } catch (err) {
        // Original d'un bloc synchronise non partage : on garde ce qu'on a.
        if (synced && err instanceof NotionApiError && (err.status === 404 || err.status === 403)) b.children = []
        else throw err
      }
    }
    return blocks
  }

  dataSource(id: string): Promise<{ id: string; title?: { plain_text?: string }[]; properties?: Record<string, unknown>; parent?: NotionSearchResult['parent']; database_parent?: NotionSearchResult['parent'] }> {
    return this.call('GET', `/v1/data_sources/${id}`)
  }

  /** Les lignes d'une source de donnees (pages). */
  queryDataSource(id: string): Promise<NotionSearchResult[]> {
    return this.all<NotionSearchResult>('POST', `/v1/data_sources/${id}/query`)
  }

  database(id: string): Promise<{ id: string; title?: { plain_text?: string }[]; parent?: NotionSearchResult['parent']; data_sources?: { id: string; name?: string }[] }> {
    return this.call('GET', `/v1/databases/${id}`)
  }

  /** Les vues d'une base (references), puis chacune en entier. */
  async views(databaseId: string): Promise<Record<string, unknown>[]> {
    const refs = await this.all<{ id: string }>('GET', `/v1/views?database_id=${databaseId}`)
    const out: Record<string, unknown>[] = []
    for (const r of refs) out.push(await this.call<Record<string, unknown>>('GET', `/v1/views/${r.id}`))
    return out
  }
}
