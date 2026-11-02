// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Recherche de secours : le plein texte local (FullTextIndexContributor de
// plugin-search, MiniSearch), vu comme un ISearchEngine. Il ne connait que
// les notes ouvertes ici : c'est le mode degrade, d'ou l'etat `unavailable`
// (« recherche limitee aux notes ouvertes »). Voir SearchEngineProvider.
//
// Limites : pas d'extraits (MiniSearch ne garde pas le texte), titre tire du
// nom du fichier, pas de filtre sur les proprietes (`where` est refuse).
import { QUERY_DEFAULT_LIMIT, QUERY_MAX_LIMIT } from '@savoire/plugin-api'
import type {
  IndexState, ISearchEngine, QueryErrorInfo, SearchHighlight, SearchHit, SearchQuery, SearchResult,
} from '@savoire/plugin-api'

/** Ce que l'adaptateur lit du contributeur `fulltext`. */
export interface FullTextIndexLike {
  search(text: string): Array<{ docId: string; path: string; score: number; terms: string[] }>
}

export interface FullTextFallbackDeps {
  /** Le contributeur du vault ouvert (recree a chaque changement de vault). */
  index: () => FullTextIndexLike | undefined
  /** Chemin actuel d'une note ; undefined : elle n'existe plus. Sans lui : le chemin de son indexation. */
  pathOf?: (docId: string) => string | undefined
  isTrashed?: (docId: string) => boolean
}

const DEGRADED: IndexState = { status: 'unavailable' }

class FallbackError extends Error implements QueryErrorInfo {
  constructor(readonly code: QueryErrorInfo['code'], message: string) {
    super(message)
  }
}

function stemOf(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1)
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(0, dot) : name
}

function extOf(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1)
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
}

/** Minuscules sans accents, caractere par caractere, avec la position d'origine de chacun. */
function foldWithMap(s: string): { text: string; at: number[] } {
  let text = ''
  const at: number[] = []
  for (let i = 0; i < s.length; i++) {
    const f = s[i].normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    for (let k = 0; k < f.length; k++) at.push(i)
    text += f
  }
  return { text, at }
}

/** Mots trouves dans le titre (debuts de mots). */
function titleHighlights(title: string, terms: string[]): SearchHighlight[] {
  const { text, at } = foldWithMap(title)
  const out: SearchHighlight[] = []
  for (const term of new Set(terms.map(t => foldWithMap(t).text).filter(Boolean))) {
    let i = text.indexOf(term)
    while (i >= 0) {
      if (i === 0 || !/[\p{L}\p{N}]/u.test(text[i - 1])) {
        out.push({ start: at[i], end: at[i + term.length - 1] + 1 })
      }
      i = text.indexOf(term, i + term.length)
    }
  }
  return out.sort((a, b) => a.start - b.start)
}

/** Signature d'une recherche : un curseur ne vaut que pour elle. */
function signature(q: SearchQuery): string {
  const s = JSON.stringify([q.text, q.folder ?? '', q.ext ?? []])
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0
  return h.toString(36)
}

export class FullTextFallbackSearch implements ISearchEngine {
  constructor(private readonly deps: FullTextFallbackDeps) {}

  async search(query: SearchQuery, options?: { signal?: AbortSignal }): Promise<SearchResult> {
    if (options?.signal?.aborted) throw new FallbackError('unavailable', 'Recherche annulee.')
    const limit = query.limit ?? QUERY_DEFAULT_LIMIT
    if (!Number.isInteger(limit) || limit < 1 || limit > QUERY_MAX_LIMIT) {
      throw new FallbackError('invalid_query', `limit : entre 1 et ${QUERY_MAX_LIMIT}.`)
    }
    if (query.where) throw new FallbackError('unavailable', 'Filtre sur les proprietes indisponible en mode degrade.')
    const sig = signature(query)
    let offset = 0
    if (query.cursor) {
      const m = /^ft:(\d+):([a-z0-9]+)$/.exec(query.cursor)
      if (!m || m[2] !== sig) throw new FallbackError('invalid_cursor', 'Curseur d\'une autre recherche.')
      offset = Number(m[1])
    }
    const text = (query.text ?? '').trim()
    const index = this.deps.index()
    if (!text || !index) return { hits: [], total: 0, index: DEGRADED }

    const folder = query.folder?.replace(/\/+$/, '')
    const exts = query.ext?.map(e => e.toLowerCase().replace(/^\./, ''))
    const all: SearchHit[] = []
    for (const r of index.search(text)) {
      if (this.deps.isTrashed?.(r.docId)) continue
      const path = this.deps.pathOf ? this.deps.pathOf(r.docId) : r.path
      if (!path || path.startsWith('.trash/')) continue
      if (folder && !path.startsWith(folder + '/')) continue
      if (exts && !exts.includes(extOf(path))) continue
      const title = stemOf(path)
      const hl = titleHighlights(title, r.terms)
      all.push({ id: r.docId, path, title, score: r.score, snippets: [], ...(hl.length ? { titleHighlights: hl } : {}) })
    }
    all.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    const hits = all.slice(offset, offset + limit)
    const end = offset + hits.length
    return {
      hits,
      total: all.length,
      index: DEGRADED,
      ...(end < all.length ? { next: `ft:${end}:${sig}` } : {}),
    }
  }

  state(): IndexState {
    return DEGRADED
  }

  onStateChange(): () => void {
    return () => {}
  }
}
