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
//  - group by : expressions separees par des virgules ; une ligne par
//    groupe. Dans select et sort, une fonction d'agregat porte sur les lignes
//    du groupe ; une expression sans agregat vaut celle de la cle (ou de la
//    premiere ligne du groupe). Une liste (multi-choix) compte dans chacun
//    de ses groupes, comme dans un kanban ;
//  - sort   : expressions, « asc » (defaut) ou « desc » ;
//  - limit  : nombre de lignes (ou de groupes) montrees (50 par defaut).
// Le bloc suit la base en direct.
import { BLOCK_DESTROY_EVENT, QUERY_MAX_LIMIT, aggregateKey, tryCompileFormula } from '@savoire/plugin-api'
import type {
  CompiledFormula, FormulaAggregateCall, FormulaRow, IQueryEngine, ISharedTree, PluginAPI, PropertyValue, Query, QueryAggregate,
  QueryFilter, QueryRow,
} from '@savoire/plugin-api'
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
  /** Une expression du select agrege : une seule ligne de resultat (une par groupe avec group by). */
  aggregate: boolean
  /** Cles de regroupement (group by) ; vide : pas de groupes. */
  groupBy: BaseQueryColumn[]
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
const CLAUSES = ['from', 'where', 'select', 'group', 'sort', 'limit'] as const

export function parseBaseQuery(text: string): ParsedBaseQuery {
  const clauses = new Map<string, string>()
  let current = ''
  for (const line of text.split('\n')) {
    if (!line.trim() || line.trim().startsWith('//')) continue
    if (/^\s/.test(line) && current) { clauses.set(current, `${clauses.get(current)} ${line.trim()}`); continue }
    const m = /^(\w+)\s*(.*)$/.exec(line.trim())
    const kw = m?.[1].toLowerCase()
    if (!m || !CLAUSES.includes(kw as typeof CLAUSES[number])) return { error: `Ligne inconnue : « ${line.trim()} » (from, where, select, group by, sort, limit)` }
    let rest = m[2].trim()
    if (kw === 'group') {
      const by = /^by\b\s*(.*)$/i.exec(rest)
      if (!by) return { error: `Ligne inconnue : « ${line.trim()} » (écrire « group by », puis les expressions)` }
      rest = by[1].trim()
    }
    const name = kw === 'group' ? 'group by' : kw!
    if (clauses.has(kw!)) return { error: `« ${name} » écrit deux fois` }
    current = kw!
    clauses.set(current, rest)
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
  const groupBy: BaseQueryColumn[] = []
  if (clauses.has('group') && !clauses.get('group')) return { error: 'group by : une expression attendue (group by prop("Statut"))' }
  for (const part of splitTop(clauses.get('group') ?? '', ',')) {
    const as = AS_RE.exec(part)
    const expr = as ? part.slice(0, as.index) : part
    const c = compile(expr, 'group by')
    if (typeof c === 'string') return { error: c }
    if (c.aggregates) return { error: 'group by : pas de fonction d\'agrégat dans une clé de groupe' }
    const bare = /^prop\(\s*"([^"]*)"\s*\)$/.exec(expr.trim())
    groupBy.push({ label: as ? (as[1] ?? as[2] ?? as[3]) : bare ? bare[1] : expr.trim(), formula: c })
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
  return { query: { from, where: whereF, select, sort, limit, aggregate, groupBy } }
}

// ── Execution ──────────────────────────────────────────────────────────────

export interface BaseQueryResult {
  columns: string[]
  rows: { row?: QueryRow; cells: (PropertyValue | { error: string })[] }[]
  /** Lignes retenues par where (avant limit). */
  matched: number
  /** La base depasse BASE_QUERY_MAX_ROWS : le calcul porte sur le debut. */
  truncated: boolean
  /** Avec group by : nombre de groupes (avant limit). */
  groups?: number
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

const TITLE_PROPS = new Set(['Nom', 'Name', '@title'])

/**
 * Le bloc peut-il etre calcule par le moteur, sans lire les lignes ?
 * Oui pour des agregats simples (sum(prop("x")), count()...) et un where
 * que le moteur fait a l'identique (voir CompiledFormula.toFilter).
 */
export function enginePlan(q: BaseQuery): { where?: QueryFilter; calls: FormulaAggregateCall[]; aggregate: QueryAggregate[] } | null {
  if (!q.aggregate || q.select.length === 0 || q.groupBy.length || q.sort.length) return null
  const calls = new Map<string, FormulaAggregateCall>()
  for (const s of q.select) {
    if (!s.formula.aggregateCalls) return null
    for (const c of s.formula.aggregateCalls) calls.set(aggregateKey(c), c)
  }
  let where: QueryFilter | undefined
  if (q.where) {
    const f = q.where.toFilter()
    if (!f) return null
    where = f
  }
  const list = [...calls.values()]
  const aggregate: QueryAggregate[] = list.map(c => ({
    op: c.fn,
    ...(c.prop !== undefined ? { field: TITLE_PROPS.has(c.prop) ? { doc: 'title' as const } : { prop: c.prop } } : {}),
  }))
  return { where, calls: list, aggregate }
}

/** Ligne d'agregat : prop("x") = les valeurs de ces lignes. */
function aggregateRow(q: BaseQuery, rows: QueryRow[], extra: CompiledFormula[] = []): FormulaRow {
  const values: Record<string, PropertyValue[]> = {}
  const props = new Set([...q.select, ...q.sort].flatMap(s => s.formula.props).concat(extra.flatMap(f => f.props)))
  for (const p of props) values[p] = rows.map(r => (p === 'Nom' || p === 'Name') && !(p in r.values) ? r.title : r.values[p] ?? null)
  return { title: '', values: values as unknown as FormulaRow['values'], rowCount: rows.length }
}

/** group by : une ligne par groupe, agregats sur les lignes du groupe. */
function evaluateGroups(q: BaseQuery, kept: QueryRow[], truncated: boolean, now: Date): BaseQueryResult {
  const groups = new Map<string, { keys: PropertyValue[]; rows: QueryRow[] }>()
  for (const r of kept) {
    const keys = q.groupBy.map(g => { const v = g.formula.evaluate(asFormulaRow(r), now); return v.ok ? v.value : null })
    // Une seule cle en liste : la ligne compte dans chacun de ses groupes.
    const sets: PropertyValue[][] = keys.length === 1 && Array.isArray(keys[0])
      ? (keys[0].length ? keys[0].map(k => [k]) : [[null]])
      : [keys]
    for (const set of sets) {
      const id = JSON.stringify(set.map(k => valueText(k)))
      const g = groups.get(id)
      if (g) g.rows.push(r)
      else groups.set(id, { keys: set, rows: [r] })
    }
  }
  const keyOf = (src: string): number => q.groupBy.findIndex(g => g.formula.source.trim() === src.trim())
  const value = (f: CompiledFormula, g: { keys: PropertyValue[]; rows: QueryRow[] }): PropertyValue | { error: string } => {
    const k = keyOf(f.source)
    if (k >= 0) return g.keys[k]
    const r = f.aggregates ? f.evaluate(aggregateRow(q, g.rows), now) : f.evaluate(asFormulaRow(g.rows[0]), now)
    return r.ok ? r.value : { error: r.error }
  }
  let list = [...groups.values()]
  const plain = (v: PropertyValue | { error: string }): PropertyValue => v !== null && typeof v === 'object' && !Array.isArray(v) ? null : v as PropertyValue
  if (q.sort.length) {
    const keys = new Map(list.map(g => [g, q.sort.map(s => plain(value(s.formula, g)))]))
    list.sort((a, b) => {
      const ka = keys.get(a)!, kb = keys.get(b)!
      for (let i = 0; i < q.sort.length; i++) {
        const c = cmp(ka[i], kb[i])
        if (c) return q.sort[i].dir === 'desc' ? -c : c
      }
      return 0
    })
  } else {
    list.sort((a, b) => {
      for (let i = 0; i < a.keys.length; i++) { const c = cmp(a.keys[i], b.keys[i]); if (c) return c }
      return 0
    })
  }
  const shown = list.slice(0, q.limit)
  // Sans select : les cles et le nombre de lignes.
  if (!q.select.length) {
    return {
      columns: [...q.groupBy.map(g => g.label), 'Lignes'],
      rows: shown.map(g => ({ cells: [...g.keys, g.rows.length] })),
      matched: kept.length, truncated, groups: list.length,
    }
  }
  return {
    columns: q.select.map(s => s.label),
    rows: shown.map(g => ({ cells: q.select.map(s => value(s.formula, g)) })),
    matched: kept.length, truncated, groups: list.length,
  }
}

/** Applique where, sort, select et limit a des lignes deja lues. */
export function evaluateBaseQuery(q: BaseQuery, all: QueryRow[], truncated = false, now = new Date()): BaseQueryResult {
  const kept = q.where
    ? all.filter(r => {
      const res = q.where!.evaluate(asFormulaRow(r), now)
      return res.ok && (res.value === true || res.value === 'true' || (typeof res.value === 'number' && res.value !== 0))
    })
    : all
  if (q.groupBy.length) return evaluateGroups(q, kept, truncated, now)
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
  // Un lien ou un bouton du rendu ne fait pas entrer l'editeur dans le bloc.
  el.addEventListener('mousedown', e => { if ((e.target as HTMLElement).closest?.('a, button')) e.stopPropagation() })
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
    // Par nom, comme la base : sans sort, l'ordre des lignes est celui-la.
    const query: Query = { from: { base: base.id, pages: { folder: folder.replace(/\/+$/, '') || undefined, ext: ['md'] } }, sort: [{ field: { doc: 'title' } }] }
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
    const followRows = () => { if (!dead) stop = engine.watch({ ...query, limit: 1 }, schedule) }
    const plan = enginePlan(q)
    if (!plan) { followRows(); return }
    // Agregats calcules par le moteur, sur toutes les lignes, sans les lire.
    if (dead) return
    let fallback = false
    stop = engine.watch({ ...query, ...(plan.where ? { where: plan.where } : {}), aggregate: plan.aggregate, limit: 1 }, r => {
      if (!alive() || fallback) return
      if (!r.aggregates || r.aggregates.length !== plan.calls.length) {
        // Moteur qui ne connait pas les agregats : on lit les lignes (apres
        // ce rappel, qui peut arriver avant que watch ait rendu son arret).
        fallback = true
        queueMicrotask(() => { stop?.(); stop = null; followRows() })
        return
      }
      const values = new Map(plan.calls.map((c, i) => [aggregateKey(c), r.aggregates![i]]))
      const cells = q.select.map(s => {
        const v = s.formula.evaluateAggregates(values)
        return v.ok ? v.value : { error: v.error }
      })
      draw({ columns: q.select.map(s => s.label), rows: [{ cells }], matched: r.total, truncated: false }, base.path)
    })
  })

  const draw = (r: BaseQueryResult, basePath: string) => {
    const open = h('a', { class: 'base-q-source', href: '#', title: `Ouvrir ${basePath}` }, `🗃️ ${basePath.split('/').pop()}`)
    open.addEventListener('click', e => { e.preventDefault(); void api.workspace.openFile(basePath) })
    const foot = h('div', { class: 'base-q-foot' }, open,
      h('span', {}, r.groups !== undefined
        ? `${Math.min(r.groups, q.limit)} / ${r.groups} groupe${r.groups > 1 ? 's' : ''} · ${r.matched} ligne${r.matched > 1 ? 's' : ''}`
        : q.aggregate ? `${r.matched} ligne${r.matched > 1 ? 's' : ''}` : `${Math.min(r.matched, q.limit)} / ${r.matched}`),
      r.truncated ? h('span', { class: 'base-q-bad' }, `calcul limité aux ${BASE_QUERY_MAX_ROWS.toLocaleString('fr-FR')} premières lignes`) : null)
    if (q.aggregate && !q.groupBy.length && r.columns.length === 1) {
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
