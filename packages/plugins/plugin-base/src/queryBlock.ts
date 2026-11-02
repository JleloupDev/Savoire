// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Bloc de requete sur une base, dans une note :
//
//   ```base
//   from db.base
//   where prop("Statut") == "Fait" and prop("Prix") > 10
//   select sum(prop("Prix")) as "Total", count()
//   ```
//
// Une clause par ligne (une ligne qui commence par une espace continue la
// precedente) ; « // » commente une ligne. Les expressions sont des formules
// (formula.ts) :
//  - where  : vrai ou faux, pour chaque ligne ;
//  - select : expressions separees par des virgules, « as "Nom" » pour le
//    titre. Avec une fonction d'agregat (sum, mean, min, max, median,
//    count), prop("x") vaut la liste des valeurs de toutes les lignes
//    retenues et le bloc rend une seule ligne ; sinon une ligne par ligne ;
//  - sort   : expressions, « asc » (defaut) ou « desc » ;
//  - limit  : nombre de lignes montrees (50 par defaut).
// Le bloc suit la base en direct.
import { BLOCK_DESTROY_EVENT, QUERY_MAX_LIMIT, tryCompileFormula } from '@savoire/plugin-api'
import type { CompiledFormula, FormulaRow, IQueryEngine, ISharedTree, PluginAPI, PropertyValue, Query, QueryRow } from '@savoire/plugin-api'
import { h, valueText } from './cells'
import { folderOfBase } from './notes'
import { readManifest } from './manifest'

export const BASE_QUERY_FENCE_RE = /^```base[ \t]*\n([\s\S]*?)\n?```\s*$/

const DEFAULT_LIMIT = 50
/** Lignes lues au plus pour un calcul (au-dela, le bloc le signale). */
export const BASE_QUERY_MAX_ROWS = 20_000

export interface BaseQueryColumn { label: string; formula: CompiledFormula }
export interface BaseQuerySort { formula: CompiledFormula; dir: 'asc' | 'desc' }

export interface BaseQuery {
  from: string
  where?: CompiledFormula
  select: BaseQueryColumn[]
  sort: BaseQuerySort[]
  limit: number
  /** Une expression du select agrege : une seule ligne de resultat. */
  aggregate: boolean
}

export type ParsedBaseQuery = { query: BaseQuery } | { error: string }

/** Coupe au premier niveau (hors guillemets, parentheses, crochets). */
function splitTop(text: string, sep: string): string[] {
  const out: string[] = []
  let depth = 0
  let quote = ''
  let start = 0
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quote) {
      if (c === '\\') i++
      else if (c === quote) quote = ''
      continue
    }
    if (c === '"' || c === "'") quote = c
    else if (c === '“') quote = '”'
    else if (c === '(' || c === '[') depth++
    else if (c === ')' || c === ']') depth--
    else if (c === sep && depth === 0) { out.push(text.slice(start, i)); start = i + 1 }
  }
  out.push(text.slice(start))
  return out.map(s => s.trim()).filter(Boolean)
}

const AS_RE = /\s+as\s+(?:"([^"]*)"|'([^']*)'|([\p{L}_][\p{L}\p{N}_]*))\s*$/u
const DIR_RE = /\s+(asc|desc)\s*$/i
const CLAUSES = ['from', 'where', 'select', 'sort', 'limit'] as const

export function parseBaseQuery(text: string): ParsedBaseQuery {
  const clauses = new Map<string, string>()
  let current = ''
  for (const line of text.split('\n')) {
    if (!line.trim() || line.trim().startsWith('//')) continue
    if (/^\s/.test(line) && current) { clauses.set(current, `${clauses.get(current)} ${line.trim()}`); continue }
    const m = /^(\w+)\s*(.*)$/.exec(line.trim())
    const kw = m?.[1].toLowerCase()
    if (!m || !CLAUSES.includes(kw as typeof CLAUSES[number])) return { error: `Ligne inconnue : « ${line.trim()} » (from, where, select, sort, limit)` }
    if (clauses.has(kw!)) return { error: `« ${kw} » écrit deux fois` }
    current = kw!
    clauses.set(current, m[2].trim())
  }
  const from = clauses.get('from')?.replace(/^\[\[|\]\]$/g, '').replace(/^["']|["']$/g, '').trim()
  if (!from) return { error: 'Il manque « from » : la base à interroger (from Projets.base)' }
  const compile = (src: string, where: string): CompiledFormula | string => {
    const c = tryCompileFormula(src)
    return 'error' in c ? `${where} : ${c.error}` : c.formula
  }
  let whereF: CompiledFormula | undefined
  const whereSrc = clauses.get('where')
  if (whereSrc) {
    const c = compile(whereSrc, 'where')
    if (typeof c === 'string') return { error: c }
    whereF = c
  }
  const select: BaseQueryColumn[] = []
  for (const part of splitTop(clauses.get('select') ?? '', ',')) {
    const as = AS_RE.exec(part)
    const expr = as ? part.slice(0, as.index) : part
    const c = compile(expr, 'select')
    if (typeof c === 'string') return { error: c }
    // Sans « as », prop("Prix") s'affiche Prix.
    const bare = /^prop\(\s*"([^"]*)"\s*\)$/.exec(expr.trim())
    select.push({ label: as ? (as[1] ?? as[2] ?? as[3]) : bare ? bare[1] : expr.trim(), formula: c })
  }
  const sort: BaseQuerySort[] = []
  for (const part of splitTop(clauses.get('sort') ?? '', ',')) {
    const d = DIR_RE.exec(part)
    const c = compile(d ? part.slice(0, d.index) : part, 'sort')
    if (typeof c === 'string') return { error: c }
    sort.push({ formula: c, dir: d?.[1].toLowerCase() === 'desc' ? 'desc' : 'asc' })
  }
  let limit = DEFAULT_LIMIT
  const limitSrc = clauses.get('limit')
  if (limitSrc !== undefined) {
    limit = Number(limitSrc)
    if (!Number.isInteger(limit) || limit < 1) return { error: 'limit : un nombre entier positif' }
  }
  const aggregate = select.some(s => s.formula.aggregates)
  return { query: { from, where: whereF, select, sort, limit, aggregate } }
}

// ── Execution ──────────────────────────────────────────────────────────────

export interface BaseQueryResult {
  columns: string[]
  rows: { row?: QueryRow; cells: (PropertyValue | { error: string })[] }[]
  /** Lignes retenues par where (avant limit). */
  matched: number
  /** La base depasse BASE_QUERY_MAX_ROWS : le calcul porte sur le debut. */
  truncated: boolean
}

const asFormulaRow = (r: QueryRow): FormulaRow => ({ title: r.title, values: r.values })

/** Lit toutes les lignes de la base (pages par curseur), au plus BASE_QUERY_MAX_ROWS. */
export async function fetchBaseRows(engine: IQueryEngine, query: Query): Promise<{ rows: QueryRow[]; truncated: boolean }> {
  const rows: QueryRow[] = []
  let cursor: string | undefined
  do {
    const r = await engine.query({ ...query, limit: QUERY_MAX_LIMIT, cursor })
    rows.push(...r.rows)
    cursor = r.next
  } while (cursor && rows.length < BASE_QUERY_MAX_ROWS)
  return { rows: rows.slice(0, BASE_QUERY_MAX_ROWS), truncated: !!cursor || rows.length > BASE_QUERY_MAX_ROWS }
}

function cmp(a: PropertyValue, b: PropertyValue): number {
  const empty = (v: PropertyValue) => v === null || v === '' || (Array.isArray(v) && v.length === 0)
  if (empty(a) || empty(b)) return empty(a) === empty(b) ? 0 : empty(a) ? 1 : -1
  if (typeof a === 'number' && typeof b === 'number') return a - b
  return valueText(a).localeCompare(valueText(b), undefined, { numeric: true, sensitivity: 'base' })
}

/** Applique where, sort, select et limit a des lignes deja lues. */
export function evaluateBaseQuery(q: BaseQuery, all: QueryRow[], truncated = false, now = new Date()): BaseQueryResult {
  const kept = q.where
    ? all.filter(r => {
      const res = q.where!.evaluate(asFormulaRow(r), now)
      return res.ok && (res.value === true || res.value === 'true' || (typeof res.value === 'number' && res.value !== 0))
    })
    : all
  if (q.aggregate) {
    // Une seule ligne : prop("x") = les valeurs de toutes les lignes retenues.
    const values: Record<string, PropertyValue[]> = {}
    const props = new Set(q.select.flatMap(s => s.formula.props))
    for (const p of props) values[p] = kept.map(r => (p === 'Nom' || p === 'Name') && !(p in r.values) ? r.title : r.values[p] ?? null)
    const agg = { title: '', values: values as unknown as FormulaRow['values'], rowCount: kept.length }
    const cells = q.select.map(s => {
      const r = s.formula.evaluate(agg, now)
      return r.ok ? r.value : { error: r.error }
    })
    return { columns: q.select.map(s => s.label), rows: [{ cells }], matched: kept.length, truncated }
  }
  let ordered = kept
  if (q.sort.length) {
    const keys = new Map(kept.map(r => [r, q.sort.map(s => { const v = s.formula.evaluate(asFormulaRow(r), now); return v.ok ? v.value : null })]))
    ordered = [...kept].sort((a, b) => {
      const ka = keys.get(a)!
      const kb = keys.get(b)!
      for (let i = 0; i < q.sort.length; i++) {
        const c = cmp(ka[i], kb[i])
        if (c) return q.sort[i].dir === 'desc' ? -c : c
      }
      return 0
    })
  }
  const shown = ordered.slice(0, q.limit)
  if (q.select.length) {
    return {
      columns: q.select.map(s => s.label),
      rows: shown.map(r => ({ row: r, cells: q.select.map(s => { const v = s.formula.evaluate(asFormulaRow(r), now); return v.ok ? v.value : { error: v.error } }) })),
      matched: kept.length,
      truncated,
    }
  }
  // Sans select : le nom et les proprietes les plus remplies.
  const counts = new Map<string, number>()
  for (const r of shown) for (const [k, v] of Object.entries(r.values)) if (v !== null && v !== '') counts.set(k, (counts.get(k) ?? 0) + 1)
  const props = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k]) => k)
  return {
    columns: ['Nom', ...props],
    rows: shown.map(r => ({ row: r, cells: [r.title, ...props.map(p => r.values[p] ?? null)] })),
    matched: kept.length,
    truncated,
  }
}

/** Dossier source lu dans le manifeste ; un arbre neuf arrive vide, on attend un peu son etat. */
async function manifestFolder(tree: ISharedTree, fallback: string): Promise<string> {
  const read = () => readManifest(tree, fallback)
  if (read().stored) return read().source.folder
  await new Promise<void>(resolve => {
    const t = setTimeout(() => { off(); resolve() }, 1500)
    const off = tree.onChange(() => { if (read().stored) { clearTimeout(t); off(); resolve() } })
  })
  return read().source.folder
}

// ── Rendu ──────────────────────────────────────────────────────────────────

function display(v: PropertyValue | { error: string }): Node {
  if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
    return h('span', { class: 'base-q-error', title: v.error }, '⚠')
  }
  if (typeof v === 'number') return document.createTextNode(v.toLocaleString('fr-FR', { maximumFractionDigits: 10 }))
  if (typeof v === 'boolean') return document.createTextNode(v ? '☑' : '☐')
  return document.createTextNode(valueText(v))
}

/** Trouve la base : chemin exact, sinon par son nom (comme un lien [[...]]). */
export async function resolveBase(api: PluginAPI, from: string): Promise<{ id: string; path: string } | null> {
  const name = /\.base$/i.test(from) ? from : `${from}.base`
  const direct = api.vault.resolveDocumentId(name)
  if (direct) return { id: direct, path: name }
  const all = await api.vault.list().catch(() => [] as string[])
  const lower = name.toLowerCase()
  const path = all.find(p => p.toLowerCase() === lower) ?? all.find(p => p.toLowerCase().endsWith(`/${lower}`))
  const id = path ? api.vault.resolveDocumentId(path) : undefined
  return path && id ? { id, path } : null
}

export function renderBaseQueryBlock(source: string, api: PluginAPI | undefined): HTMLElement {
  const el = h('div', { class: 'base-q', 'data-testid': 'base-query' })
  const fail = (msg: string) => el.replaceChildren(h('div', { class: 'base-q-message base-q-bad', 'data-testid': 'base-query-error' }, `⚠ ${msg}`))
  const parsed = parseBaseQuery(source)
  if ('error' in parsed) { fail(parsed.error); return el }
  const q = parsed.query
  const engine = api?.query
  if (!api || !engine) { fail('Aucun moteur de requêtes : ouvrez un vault.'); return el }
  el.replaceChildren(h('div', { class: 'base-q-message' }, '…'))

  let stop: (() => void) | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  let running = false
  let again = false
  let dead = false
  // Retire par l'editeur (bloc modifie, note fermee) : on cesse de suivre.
  // Un simple detachement (onglet masque) ne compte pas : le bloc revient.
  el.addEventListener(BLOCK_DESTROY_EVENT, () => {
    dead = true
    stop?.(); stop = null
    if (timer) clearTimeout(timer)
  }, { once: true })
  const alive = (): boolean => !dead

  void resolveBase(api, q.from).then(async base => {
    if (!base) { fail(`Base introuvable : « ${q.from} »`); return }
    // Dossier source de la base : celui de son manifeste quand on sait le lire.
    let folder = folderOfBase(base.path)
    const tree = await api.vault.openTree?.(base.id).catch(() => undefined)
    if (tree) {
      folder = await manifestFolder(tree, folder)
      api.vault.closeTree?.(base.id)
    }
    const query: Query = { from: { base: base.id, pages: { folder: folder.replace(/\/+$/, '') || undefined, ext: ['md'] } } }
    const run = async () => {
      if (!alive()) return
      if (running) { again = true; return }
      running = true
      try {
        const { rows, truncated } = await fetchBaseRows(engine, query)
        draw(evaluateBaseQuery(q, rows, truncated), base.path)
      } catch (err) {
        fail((err as { message?: string })?.message ?? String(err))
      } finally {
        running = false
        if (again) { again = false; schedule() }
      }
    }
    const schedule = () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => { timer = null; void run() }, 120)
    }
    // Suivi en direct : la plus petite requete suivie sert de signal.
    if (!dead) stop = engine.watch({ ...query, limit: 1 }, schedule)
  })

  const draw = (r: BaseQueryResult, basePath: string) => {
    const open = h('a', { class: 'base-q-source', href: '#', title: `Ouvrir ${basePath}` }, `🗃️ ${basePath.split('/').pop()}`)
    open.addEventListener('click', e => { e.preventDefault(); void api.workspace.openFile(basePath) })
    const foot = h('div', { class: 'base-q-foot' }, open,
      h('span', {}, q.aggregate ? `${r.matched} ligne${r.matched > 1 ? 's' : ''}` : `${Math.min(r.matched, q.limit)} / ${r.matched}`),
      r.truncated ? h('span', { class: 'base-q-bad' }, `calcul limité aux ${BASE_QUERY_MAX_ROWS.toLocaleString('fr-FR')} premières lignes`) : null)
    if (q.aggregate && r.columns.length === 1) {
      el.replaceChildren(h('div', { class: 'base-q-value', 'data-testid': 'base-query-value', title: r.columns[0] }, display(r.rows[0].cells[0])), foot)
      return
    }
    const head = h('tr', {}, ...r.columns.map(c => h('th', {}, c)))
    const body = r.rows.map(({ row, cells }) => h('tr', { 'data-testid': 'base-query-row' }, ...cells.map((c, i) => {
      const td = h('td', {}, display(c))
      if (i === 0 && row && row.path && !q.select.length) {
        const a = h('a', { href: '#' }, display(c))
        a.addEventListener('click', e => { e.preventDefault(); void api.workspace.openFile(row.path) })
        td.replaceChildren(a)
      }
      return td
    })))
    el.replaceChildren(h('table', { class: 'base-q-table' }, h('thead', {}, head), h('tbody', {}, ...body)), foot)
  }
  return el
}
