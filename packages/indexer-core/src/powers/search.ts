// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Pouvoir `search` : la recherche plein texte (ISearchEngine) sur FTS5.
//
// Tables :
//  - search_fts : index FTS5 SANS contenu (contentless_delete), colonnes
//    title, body (texte brut), props (proprietes texte). On y ecrit les mots
//    deja replies et decoupes en JS (memes regles que le moteur de
//    reference) ; le tokenizer unicode61 (remove_diacritics 2) les relit ;
//  - search_text : les sections de chaque note (titre, texte), en JSON, pour
//    les extraits. Le texte n'est stocke qu'une fois.
//
// Pertinence : bm25, le titre pese 10, les proprietes 3, le texte 1. A score
// egal, l'ordre de l'id. Pagination par cle (score, id).
//
// Il offre aussi a `query` son filtre « tous ces mots » (Query.text).
import { QUERY_DEFAULT_LIMIT, QUERY_MAX_LIMIT } from '@savoire/plugin-api'
import type {
  PropertyValue, QueryFilter, SearchHit, SearchQuery, SearchResult,
} from '@savoire/plugin-api'
import { sql } from '../driver'
import type { SqlStatement } from '../driver'
import { IndexError, invalid } from '../errors'
import type { Section } from '../extract/markdown'
import type { NoteRecord } from '../extract/note'
import type { DocRef, IndexPower, PowerContext } from '../power'
import { method } from '../power'
import { decodeOpaque, encodeOpaque, hashText, words } from '../text'
import { asObject, optString, optStringList } from '../validate'
import { MAX_FILTER_NODES, TRUE, and, countNodes, parseFilter } from './filter'
import type { Frag } from './filter'
import type { QueryApi, TextSearchApi } from './query'
import { buildSnippets, ftsMatch, highlightsOf, isEmptySearch, parseSearchText } from './snippets'
import type { SearchTerms } from './snippets'

const WEIGHTS = '10.0, 1.0, 3.0'

/** Les proprietes texte d'une note, pour la recherche. */
export function propsText(props: Record<string, PropertyValue>): string {
  const out: string[] = []
  for (const v of Object.values(props)) {
    for (const x of Array.isArray(v) ? v : [v]) if (typeof x === 'string' && x) out.push(x)
  }
  return out.join('\n')
}

function ftsRow(n: number, title: string, sections: readonly Section[], props: Record<string, PropertyValue>): SqlStatement {
  return sql('INSERT INTO search_fts (rowid, title, body, props) VALUES (?, ?, ?, ?)',
    n,
    words(title).join(' '),
    words(sections.map(s => s.text).join('\n')).join(' '),
    words(propsText(props)).join(' '))
}

function sectionsJson(sections: readonly Section[]): string {
  return JSON.stringify(sections.map(s => (s.heading !== undefined ? [s.text, s.heading, s.level ?? 1] : [s.text])))
}

function parseSections(json: string): Section[] {
  try {
    return (JSON.parse(json) as [string, string?, number?][]).map(([text, heading, level]) =>
      heading !== undefined ? { text, heading, level } : { text })
  } catch {
    return []
  }
}

interface ParsedSearch {
  query: SearchQuery
  terms: SearchTerms
  where?: QueryFilter
  limit: number
  key: string
}

export function parseSearch(v: unknown): ParsedSearch {
  const q = asObject(v, 'recherche')
  const limit = q.limit ?? QUERY_DEFAULT_LIMIT
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > QUERY_MAX_LIMIT) {
    throw invalid(`limit doit etre entre 1 et ${QUERY_MAX_LIMIT}.`)
  }
  const text = optString(q, 'text', 1000) ?? ''
  const folder = optString(q, 'folder', 1024)
  const ext = optStringList(q, 'ext', 50, 32)
  const where = q.where === undefined || q.where === null ? undefined : parseFilter(q.where)
  if (where && countNodes(where) > MAX_FILTER_NODES) {
    throw new IndexError('too_complex', `Filtre trop complexe (plus de ${MAX_FILTER_NODES} conditions).`)
  }
  const cursor = optString(q, 'cursor', 8192)
  const { cursor: _c, limit: _l, ...rest } = q
  return {
    query: { text, ...(folder !== undefined ? { folder } : {}), ...(ext ? { ext } : {}), ...(cursor !== undefined ? { cursor } : {}) },
    terms: parseSearchText(text),
    ...(where ? { where } : {}),
    limit,
    key: hashText(JSON.stringify(rest)),
  }
}

function decodeCursor(cursor: string, key: string): { score: number; id: string } {
  try {
    const c = decodeOpaque(cursor) as { q?: unknown; s?: unknown; id?: unknown }
    if (c && c.q === key && typeof c.s === 'number' && Number.isFinite(c.s) && typeof c.id === 'string') return { score: c.s, id: c.id }
  } catch { /* plus bas */ }
  throw new IndexError('invalid_cursor', 'Ce curseur ne correspond pas a cette recherche.')
}

export async function runSearch(ctx: PowerContext, parsed: ParsedSearch): Promise<SearchResult> {
  const { query, terms, where, limit, key } = parsed
  if (isEmptySearch(terms)) return { hits: [], total: 0, index: ctx.state() }
  const queryApi = ctx.api<QueryApi>('query')
  if (!queryApi) throw invalid('Recherche indisponible : pouvoir query absent de cet index.')
  const cond = and([queryApi.notesFilter(query.folder, query.ext), where ? queryApi.compileFilter(where) : TRUE])
  const last = query.cursor ? decodeCursor(query.cursor, key) : null
  const after: Frag = last ? { sql: '(score < ? OR (score = ? AND id > ?))', params: [last.score, last.score, last.id] } : TRUE

  const page = await ctx.driver.all<{ n: number; id: string; score: number; total: number }>(
    `WITH m AS MATERIALIZED (
       SELECT search_fts.rowid AS n, -bm25(search_fts, ${WEIGHTS}) AS score FROM search_fts WHERE search_fts MATCH ?
     ),
     h AS MATERIALIZED (SELECT m.n AS n, m.score AS score, d.id AS id FROM m JOIN docs d ON d.n = m.n WHERE ${cond.sql})
     SELECT h.*, (SELECT count(*) FROM h) AS total FROM h WHERE ${after.sql} ORDER BY score DESC, id LIMIT ?`,
    [ftsMatch(terms), ...cond.params, ...after.params, limit + 1])

  let total: number
  if (page.length) total = Number(page[0].total)
  else {
    const c = await ctx.driver.all<{ c: number }>(
      `SELECT count(*) AS c FROM search_fts JOIN docs d ON d.n = search_fts.rowid WHERE search_fts MATCH ? AND ${cond.sql}`,
      [ftsMatch(terms), ...cond.params])
    total = Number(c[0]?.c ?? 0)
  }

  const shown = page.slice(0, limit)
  const info = new Map<number, { path: string; title: string; sections: string }>()
  if (shown.length) {
    const rows = await ctx.driver.all<{ n: number; path: string; title: string; sections: string | null }>(
      `SELECT d.n AS n, d.path AS path, d.title AS title, t.sections AS sections
       FROM docs d LEFT JOIN search_text t ON t.doc = d.n WHERE d.n IN (${shown.map(() => '?').join(', ')})`,
      shown.map(r => r.n))
    for (const r of rows) info.set(Number(r.n), { path: r.path, title: r.title, sections: r.sections ?? '[]' })
  }
  const hits: SearchHit[] = shown.map(r => {
    const d = info.get(Number(r.n))
    const title = d?.title ?? ''
    const titleHighlights = highlightsOf(title, terms)
    return {
      id: r.id,
      path: d?.path ?? '',
      title,
      score: Number(r.score),
      ...(titleHighlights.length ? { titleHighlights } : {}),
      snippets: buildSnippets(parseSections(d?.sections ?? '[]'), terms),
    }
  })
  const lastShown = shown[shown.length - 1]
  return {
    hits,
    ...(page.length > limit ? { next: encodeOpaque({ q: key, s: Number(lastShown.score), id: lastShown.id }) } : {}),
    total,
    index: ctx.state(),
  }
}

const textApi: TextSearchApi = {
  textFilter(text: string): Frag | null {
    const terms = { terms: [...new Set(words(text))], phrases: [] }
    if (terms.terms.length > 32) throw new IndexError('too_complex', 'Recherche trop longue (32 mots au plus).')
    if (!terms.terms.length) return null
    return {
      sql: 'd.n IN (SELECT search_fts.rowid FROM search_fts WHERE search_fts MATCH ?)',
      params: [ftsMatch(terms, ['title', 'body'])],
    }
  },
}

function write(_ctx: PowerContext, doc: DocRef, note: NoteRecord): SqlStatement[] {
  return [
    ftsRow(doc.n, note.title, note.sections, note.props),
    sql('INSERT INTO search_text (doc, sections) VALUES (?, ?)', doc.n, sectionsJson(note.sections)),
  ]
}

export const searchPower: IndexPower = {
  name: 'search',
  version: 1,
  tables: ['search_fts', 'search_text'],
  schema: [
    `CREATE VIRTUAL TABLE IF NOT EXISTS search_fts USING fts5(
      title, body, props,
      content='', contentless_delete=1,
      tokenize='unicode61 remove_diacritics 2'
    )`,
    'CREATE TABLE IF NOT EXISTS search_text (doc INTEGER PRIMARY KEY, sections TEXT NOT NULL)',
  ],
  write,
  remove: (_ctx, doc) => [
    sql('DELETE FROM search_fts WHERE rowid = ?', doc.n),
    sql('DELETE FROM search_text WHERE doc = ?', doc.n),
  ],
  async move(ctx, doc, from, to) {
    if (from.title === to.title) return []
    const rows = await ctx.driver.all<{ sections: string | null; props: string }>(
      'SELECT t.sections AS sections, d.props AS props FROM docs d LEFT JOIN search_text t ON t.doc = d.n WHERE d.n = ?', [doc.n])
    if (!rows.length) return []
    return [
      sql('DELETE FROM search_fts WHERE rowid = ?', doc.n),
      ftsRow(doc.n, to.title, parseSections(rows[0].sections ?? '[]'), JSON.parse(rows[0].props) as Record<string, PropertyValue>),
    ]
  },
  methods: {
    run: method<ParsedSearch, SearchResult>({
      parse: parseSearch,
      run: (ctx, parsed) => runSearch(ctx, parsed),
    }),
  },
  api: textApi,
}
