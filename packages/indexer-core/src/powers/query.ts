// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Pouvoir `query` : les requetes declaratives (IQueryEngine) sur SQL.
//
// Table `props` : une ligne par valeur de propriete (une par element d'une
// liste). `txt` est la copie repliee (foldText, calculee en JS), `num` le
// nombre, `val` la valeur exacte en JSON (pour les groupes). Une valeur vide
// (null, '', []) n'a pas de ligne.
//
// Pagination PAR CLE : le curseur porte les cles de tri de la derniere ligne
// rendue et l'id ; la page suivante reprend juste apres, sans OFFSET. Une
// ligne ajoutee ou retiree entre deux pages ne decale pas les autres.
// Le curseur porte aussi l'empreinte de sa requete : il ne vaut que pour elle.
//
// Ecart connu avec le moteur de reference : sur une propriete ou se melangent
// nombres et textes, SQLite range tous les nombres avant les textes (le
// moteur en memoire compare alors en texte, sans ordre total).
import { QUERY_DEFAULT_LIMIT, QUERY_MAX_LIMIT } from '@savoire/plugin-api'
import type {
  PropertyValue, Query, QueryField, QueryFilter, QueryGroup, QueryResult, QueryRow, QuerySort,
} from '@savoire/plugin-api'
import { sql } from '../driver'
import type { SqlStatement, SqlValue } from '../driver'
import { IndexError, invalid } from '../errors'
import { folderPrefix, normalizeExts } from '../paths'
import type { IndexPower, PowerContext } from '../power'
import { method } from '../power'
import { compareIds, compareValues, decodeOpaque, encodeOpaque, foldText, hashText } from '../text'
import { asObject, optString, optStringList } from '../validate'
import {
  DOC_FIELDS, FALSE, MAX_FILTER_NODES, TRUE, and, compileFilter, countNodes, parseField, parseFilter, sortColumn,
} from './filter'
import type { Frag } from './filter'

const MAX_SORTS = 8
const MAX_SELECT = 200
/** Au-dela, les groupes les moins nombreux sont omis. */
export const MAX_GROUPS = 1000

/** Ce que le pouvoir `search` offre aux autres : un filtre plein texte. */
export interface TextSearchApi {
  /** Condition « contient tous ces mots (prefixes), titre et texte ». null : aucun mot. */
  textFilter(text: string): Frag | null
}

export interface ParsedQuery {
  query: Query
  limit: number
  /** Empreinte de la requete sans curseur ni taille de page. */
  key: string
}

/** Proprietes de la note -> lignes de `props`. */
export function propRows(doc: number, props: Record<string, PropertyValue>): SqlStatement[] {
  const out: SqlStatement[] = []
  const insert = 'INSERT INTO props (doc, key, idx, list, num, txt, val) VALUES (?, ?, ?, ?, ?, ?, ?)'
  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined || value === '') continue
    const items: unknown[] = Array.isArray(value) ? value : [value]
    const list = Array.isArray(value) ? 1 : 0
    items.forEach((x, idx) => {
      out.push(sql(insert, doc, key, idx, list,
        typeof x === 'number' ? x : null,
        foldText(String(x)),
        JSON.stringify(x) ?? 'null'))
    })
  }
  return out
}

// ── Verification de la requete ──────────────────────────────────────────

function parseSort(v: unknown): QuerySort[] | undefined {
  if (v === undefined || v === null) return undefined
  if (!Array.isArray(v)) throw invalid('sort : liste attendue.')
  if (v.length > MAX_SORTS) throw new IndexError('too_complex', `Trop de criteres de tri (${MAX_SORTS} au plus).`)
  return v.map(s => {
    const o = asObject(s, 'tri')
    if (o.dir !== undefined && o.dir !== 'asc' && o.dir !== 'desc') throw invalid('tri : dir vaut asc ou desc.')
    return { field: parseField(o.field, 'tri'), ...(o.dir ? { dir: o.dir as 'asc' | 'desc' } : {}) }
  })
}

function parseSource(v: unknown): Query['from'] {
  const from = v as Record<string, unknown> | null
  if (from && typeof from === 'object' && !Array.isArray(from)) {
    if ('notes' in from && from.notes) {
      const folder = optString(from, 'folder', 1024)
      const ext = optStringList(from, 'ext', 50, 32)
      return { notes: true, ...(folder !== undefined ? { folder } : {}), ...(ext ? { ext } : {}) }
    }
    if ('base' in from && typeof from.base === 'string' && from.base) {
      if (from.base.length > 256) throw invalid('Source : id de base trop long.')
      if (from.pages === undefined || from.pages === null) return { base: from.base }
      const pages = asObject(from.pages, 'pages')
      const folder = optString(pages, 'folder', 1024)
      const ext = optStringList(pages, 'ext', 50, 32)
      const where = pages.where === undefined || pages.where === null ? undefined : parseFilter(pages.where)
      return {
        base: from.base,
        pages: { ...(folder !== undefined ? { folder } : {}), ...(ext ? { ext } : {}), ...(where ? { where } : {}) },
      }
    }
  }
  throw invalid('Source inconnue.')
}

/** Verifie une requete venue du reseau ; meme ordre de refus que le moteur de reference. */
export function parseQuery(v: unknown): ParsedQuery {
  const q = asObject(v, 'requete')
  const limit = q.limit ?? QUERY_DEFAULT_LIMIT
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > QUERY_MAX_LIMIT) {
    throw invalid(`limit doit etre entre 1 et ${QUERY_MAX_LIMIT}.`)
  }
  const where = q.where === undefined || q.where === null ? undefined : parseFilter(q.where)
  const from = parseSource(q.from)
  const pagesWhere = 'base' in from ? from.pages?.where : undefined
  const nodes = (where ? countNodes(where) : 0) + (pagesWhere ? countNodes(pagesWhere) : 0)
  if (nodes > MAX_FILTER_NODES) throw new IndexError('too_complex', `Filtre trop complexe (plus de ${MAX_FILTER_NODES} conditions).`)
  const text = optString(q, 'text', 1000)
  const sort = parseSort(q.sort)
  const select = optStringList(q, 'select', MAX_SELECT, 256)
  const groupBy = q.groupBy === undefined || q.groupBy === null ? undefined : parseField(q.groupBy, 'groupBy')
  const cursor = optString(q, 'cursor', 8192)
  const { cursor: _c, limit: _l, ...rest } = q
  const query: Query = {
    from,
    ...(where ? { where } : {}),
    ...(text !== undefined ? { text } : {}),
    ...(sort ? { sort } : {}),
    ...(select ? { select } : {}),
    ...(groupBy ? { groupBy } : {}),
    limit,
    ...(cursor !== undefined ? { cursor } : {}),
  }
  return { query, limit, key: hashText(JSON.stringify(rest)) }
}

// ── Compilation ──────────────────────────────────────────────────────────

/** Notes d'un dossier et d'extensions (corbeille jamais indexee ; lignes legeres exclues). */
export function notesFilter(folder: string | undefined, ext: readonly string[] | undefined): Frag {
  const parts: Frag[] = [{ sql: 'd.base IS NULL', params: [] }]
  const prefix = folderPrefix(folder)
  if (prefix) {
    // Intervalle exact des chemins qui commencent par « dossier/ » : le
    // caractere qui suit '/' est '0'.
    parts.push({ sql: 'd.path >= ? AND d.path < ?', params: [prefix, prefix.slice(0, -1) + '0'] })
  }
  const exts = normalizeExts(ext)
  if (exts) {
    parts.push(exts.length ? { sql: `d.ext IN (${exts.map(() => '?').join(', ')})`, params: exts } : FALSE)
  }
  return and(parts)
}

function sourceFilter(from: Query['from']): Frag {
  if ('notes' in from) return notesFilter(from.folder, from.ext)
  const rows: Frag = { sql: 'd.base = ?', params: [from.base] }
  if (!from.pages) return rows
  const pages = and([notesFilter(from.pages.folder, from.pages.ext), from.pages.where ? compileFilter(from.pages.where) : TRUE])
  return { sql: `(${rows.sql} OR ${pages.sql})`, params: [...rows.params, ...pages.params] }
}

/** Condition complete d'une requete sur `d`. */
export function queryConditions(ctx: PowerContext, query: Query): Frag {
  const parts: Frag[] = [sourceFilter(query.from)]
  if (query.text) {
    const search = ctx.api<TextSearchApi>('search')
    const words = search ? search.textFilter(query.text) : undefined
    if (words === undefined) throw invalid('Plein texte indisponible : pouvoir search absent de cet index.')
    if (words) parts.push(words)
  }
  if (query.where) parts.push(compileFilter(query.where))
  return and(parts)
}

interface Last { k: SqlValue[]; id: string }

function decodeCursor(cursor: string, key: string, sorts: number): Last {
  try {
    const c = decodeOpaque(cursor) as { q?: unknown; k?: unknown; id?: unknown }
    if (c && c.q === key && typeof c.id === 'string' && Array.isArray(c.k) && c.k.length === sorts
      && c.k.every(v => v === null || typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v)))) {
      return { k: c.k as SqlValue[], id: c.id }
    }
  } catch { /* plus bas */ }
  throw new IndexError('invalid_cursor', 'Ce curseur ne correspond pas a cette requete.')
}

/**
 * Lignes situees APRES la derniere rendue, dans l'ordre (cle vide, cle,
 * ..., id). `s<i>` : cles de tri, NULL si vides (toujours en dernier).
 */
function afterLast(sorts: readonly QuerySort[], last: Last, idCol = 'id'): Frag {
  const ors: Frag[] = []
  const eqs: Frag[] = []
  sorts.forEach((s, i) => {
    const col = `s${i}`
    const v = last.k[i]
    if (v === null) {
      eqs.push({ sql: `${col} IS NULL`, params: [] })
      return
    }
    ors.push(and([...eqs, { sql: `${col} IS NULL`, params: [] }]))
    eqs.push({ sql: `${col} IS NOT NULL`, params: [] })
    ors.push(and([...eqs, { sql: `${col} ${s.dir === 'desc' ? '<' : '>'} ?`, params: [v] }]))
    eqs.push({ sql: `${col} = ?`, params: [v] })
  })
  ors.push(and([...eqs, { sql: `${idCol} > ?`, params: [last.id] }]))
  return { sql: '(' + ors.map(o => o.sql).join(' OR ') + ')', params: ors.flatMap(o => o.params) }
}

function sortGroups(groups: QueryGroup[]): QueryGroup[] {
  return groups.sort((a, b) =>
    b.count - a.count
    || Number(a.key === null) - Number(b.key === null)
    || (a.key === null || b.key === null ? 0 : compareValues(a.key, b.key))
    || compareIds(JSON.stringify(a.key), JSON.stringify(b.key)))
}

async function groupsOf(ctx: PowerContext, field: QueryField, cond: Frag): Promise<QueryGroup[]> {
  const out: QueryGroup[] = []
  if ('prop' in field) {
    // Une seule passe : une ligne par valeur (par element d'une liste), NULL
    // pour un document sans valeur.
    const rows = await ctx.driver.all<{ v: string | null; c: number }>(
      `SELECT g.val AS v, count(*) AS c FROM docs d LEFT JOIN props g ON g.doc = d.n AND g.key = ? WHERE ${cond.sql} GROUP BY g.val`,
      [field.prop, ...cond.params])
    for (const r of rows) out.push({ key: r.v === null ? null : JSON.parse(r.v) as PropertyValue, count: Number(r.c) })
  } else {
    const col = DOC_FIELDS[field.doc]
    const rows = await ctx.driver.all<{ v: string | null; c: number }>(
      `SELECT CASE WHEN ${col.fold} IS NULL THEN NULL ELSE ${col.raw} END AS v, count(*) AS c FROM docs d WHERE ${cond.sql} GROUP BY v`,
      cond.params)
    for (const r of rows) out.push({ key: r.v, count: Number(r.c) })
  }
  return sortGroups(out).slice(0, MAX_GROUPS)
}

/** Execute une requete deja verifiee. */
export async function runQuery(ctx: PowerContext, parsed: ParsedQuery): Promise<QueryResult> {
  const { query, limit, key } = parsed
  const sorts = query.sort ?? []
  const cond = queryConditions(ctx, query)
  const keys = sorts.map((s, i) => sortColumn(s.field, i))
  const last = query.cursor ? decodeCursor(query.cursor, key, sorts.length) : null
  const after = last ? afterLast(sorts, last, sorts.length ? 'id' : 'd.id') : TRUE
  const order = [...sorts.map((s, i) => `(s${i} IS NULL), s${i}${s.dir === 'desc' ? ' DESC' : ''}`), 'id'].join(', ')
  const cols = keys.map((k, i) => `, ${k.expr} AS s${i}`).join('')
  const joins = keys.flatMap(k => (k.join ? [k.join] : []))

  type PageRow = { n: number; id: string; total?: number } & Record<string, SqlValue>
  let page: PageRow[]
  if (sorts.length) {
    // Cles de tri calculees une fois par ligne retenue ; total compte au passage.
    page = await ctx.driver.all<PageRow>(
      `WITH m AS MATERIALIZED (
         SELECT d.n AS n, d.id AS id${cols} FROM docs d ${joins.map(j => j.sql).join(' ')} WHERE ${cond.sql}
       )
       SELECT m.*, (SELECT count(*) FROM m) AS total FROM m WHERE ${after.sql} ORDER BY ${order} LIMIT ?`,
      [...joins.flatMap(j => j.params), ...cond.params, ...after.params, limit + 1])
  } else {
    // Ordre de l'id : l'index de docs.id le donne, sans tout trier.
    page = await ctx.driver.all<PageRow>(
      `SELECT d.n AS n, d.id AS id FROM docs d WHERE ${cond.sql} AND ${after.sql} ORDER BY d.id LIMIT ?`,
      [...cond.params, ...after.params, limit + 1])
  }

  let total: number
  if (page.length && page[0].total !== undefined) total = Number(page[0].total)
  else total = Number((await ctx.driver.all<{ c: number }>(`SELECT count(*) AS c FROM docs d WHERE ${cond.sql}`, cond.params))[0]?.c ?? 0)

  const shown = page.slice(0, limit)
  const docs = new Map<number, { path: string; title: string; props: string }>()
  if (shown.length) {
    const rows = await ctx.driver.all<{ n: number; path: string; title: string; props: string }>(
      `SELECT n, path, title, props FROM docs WHERE n IN (${shown.map(() => '?').join(', ')})`,
      shown.map(r => r.n))
    for (const r of rows) docs.set(Number(r.n), r)
  }
  const rows: QueryRow[] = shown.map(r => {
    const d = docs.get(Number(r.n))
    const props = d ? JSON.parse(d.props) as Record<string, PropertyValue> : {}
    return {
      id: r.id,
      path: d?.path ?? '',
      title: d?.title ?? '',
      values: query.select
        ? Object.fromEntries(query.select.filter(k => Object.prototype.hasOwnProperty.call(props, k)).map(k => [k, props[k]]))
        : props,
    }
  })

  let next: string | undefined
  if (page.length > limit) {
    const last = shown[shown.length - 1]
    next = encodeOpaque({ q: key, k: sorts.map((_s, i) => last[`s${i}`] ?? null), id: last.id })
  }
  const groups = query.groupBy ? await groupsOf(ctx, query.groupBy, cond) : undefined
  return {
    rows,
    ...(next ? { next } : {}),
    total,
    ...(groups ? { groups } : {}),
    index: ctx.state(),
  }
}

/** Ce que `query` offre aux autres pouvoirs. */
export interface QueryApi {
  /** Condition SQL (sur `d`) d'un filtre deja verifie. */
  compileFilter(filter: QueryFilter): Frag
  notesFilter(folder: string | undefined, ext: readonly string[] | undefined): Frag
}

export const queryPower: IndexPower = {
  name: 'query',
  version: 1,
  tables: ['props'],
  schema: [
    `CREATE TABLE IF NOT EXISTS props (
      doc INTEGER NOT NULL,
      key TEXT NOT NULL,
      idx INTEGER NOT NULL,
      list INTEGER NOT NULL,
      num REAL,
      txt TEXT NOT NULL,
      val TEXT NOT NULL,
      PRIMARY KEY (doc, key, idx)
    ) WITHOUT ROWID`,
    'CREATE INDEX IF NOT EXISTS props_txt ON props (key, txt)',
    'CREATE INDEX IF NOT EXISTS props_num ON props (key, num) WHERE num IS NOT NULL',
  ],
  write: (_ctx, doc, note) => propRows(doc.n, note.props),
  remove: (_ctx, doc) => [sql('DELETE FROM props WHERE doc = ?', doc.n)],
  methods: {
    run: method<ParsedQuery, QueryResult>({
      parse: parseQuery,
      run: (ctx, parsed) => runQuery(ctx, parsed),
    }),
  },
  api: { compileFilter, notesFilter } satisfies QueryApi,
}
