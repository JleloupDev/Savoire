// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Filtres et tris sur des colonnes formules.
//
// Une formule se calcule dans le client : aucun index ne la connait. Quand
// une requete filtre ou trie sur une formule (champ { prop: '=Nom' }), on lit
// toutes les lignes de la base (par pages, BASE_QUERY_MAX_ROWS au plus), puis
// on filtre, trie et pagine ici. Sinon la requete part telle quelle au moteur.
// Meme contrat IQueryEngine : le tableau et le kanban ne voient pas la
// difference.
import type {
  CompiledFormula, IQueryEngine, IndexState, PropertyValue, Query, QueryField, QueryFilter,
  QueryGroup, QueryResult, QueryRow, QuerySort,
} from '@savoire/plugin-api'
import { isFormulaKey } from './manifest'
import { fetchBaseRows } from './queryBlock'

/** La formule d'une cle, compilee ; undefined si elle n'existe pas ou est fausse. */
export type FormulaLookup = (key: string) => CompiledFormula | undefined

const isFormulaField = (f: QueryField): boolean => 'prop' in f && isFormulaKey(f.prop)

function usesFormula(filter: QueryFilter | undefined): boolean {
  if (!filter) return false
  if ('and' in filter) return filter.and.some(usesFormula)
  if ('or' in filter) return filter.or.some(usesFormula)
  if ('not' in filter) return usesFormula(filter.not)
  return isFormulaField(filter.field)
}

/** La requete a-t-elle besoin d'un calcul cote client ? */
export function needsFormulas(q: Query): boolean {
  return usesFormula(q.where) || !!q.sort?.some(s => isFormulaField(s.field)) || (!!q.groupBy && isFormulaField(q.groupBy))
}

/**
 * Coupe le filtre : ce que le moteur sait faire (sans formule) et le reste.
 * Seul un « et » de premier niveau se coupe ; un « ou » qui touche une
 * formule part entier cote client.
 */
export function splitWhere(where: QueryFilter | undefined): { engine?: QueryFilter; client?: QueryFilter } {
  if (!where) return {}
  if (!usesFormula(where)) return { engine: where }
  if (!('and' in where)) return { client: where }
  const e = where.and.filter(f => !usesFormula(f))
  const c = where.and.filter(f => usesFormula(f))
  const join = (xs: QueryFilter[]) => xs.length === 0 ? undefined : xs.length === 1 ? xs[0] : { and: xs }
  return { engine: join(e), client: join(c) }
}

// ── Comparaisons, comme le moteur en memoire ─────────────────────────────

const fold = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
const isEmpty = (v: PropertyValue | undefined) => v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0)

function compareScalar(a: PropertyValue, b: PropertyValue): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b
  if (typeof a === 'boolean' && typeof b === 'boolean') return Number(a) - Number(b)
  // Un nombre de formule face a la valeur saisie en texte (« 10 ») : en nombre.
  if (typeof a === 'number' && typeof b === 'string' && b.trim() !== '' && Number.isFinite(Number(b))) return a - Number(b)
  const fa = fold(String(a)), fb = fold(String(b))
  return fa < fb ? -1 : fa > fb ? 1 : 0
}

function fieldOf(row: QueryRow, field: QueryField, formula: FormulaLookup): PropertyValue | undefined {
  if ('prop' in field) {
    if (!isFormulaKey(field.prop)) return row.values[field.prop]
    const f = formula(field.prop)
    if (!f) return undefined
    const r = f.evaluate(row)
    return r.ok ? r.value : undefined
  }
  switch (field.doc) {
    case 'title': return row.title
    case 'path': return row.path
    case 'folder': return row.path.includes('/') ? row.path.slice(0, row.path.lastIndexOf('/')) : ''
    case 'ext': { const n = row.path.slice(row.path.lastIndexOf('/') + 1); const i = n.lastIndexOf('.'); return i <= 0 ? '' : n.slice(i + 1).toLowerCase() }
    default: return undefined
  }
}

export function matchRow(row: QueryRow, filter: QueryFilter, formula: FormulaLookup): boolean {
  if ('and' in filter) return filter.and.every(f => matchRow(row, f, formula))
  if ('or' in filter) return filter.or.some(f => matchRow(row, f, formula))
  if ('not' in filter) return !matchRow(row, filter.not, formula)
  const v = fieldOf(row, filter.field, formula)
  const want = filter.value
  if (filter.op === 'empty') return isEmpty(v)
  if (filter.op === 'notEmpty') return !isEmpty(v)
  if (isEmpty(v) || want === undefined || want === null) return false
  const eq = (x: PropertyValue, w: PropertyValue) => compareScalar(x, w) === 0
  if (Array.isArray(v)) {
    switch (filter.op) {
      case 'eq': case 'contains': return v.some(x => eq(x, want))
      case 'neq': return !v.some(x => eq(x, want))
      case 'in': return Array.isArray(want) && v.some(x => want.some(w => eq(x, w)))
      default: return false
    }
  }
  const a = v as PropertyValue
  switch (filter.op) {
    case 'eq': return eq(a, want)
    case 'neq': return !eq(a, want)
    case 'lt': return compareScalar(a, want) < 0
    case 'lte': return compareScalar(a, want) <= 0
    case 'gt': return compareScalar(a, want) > 0
    case 'gte': return compareScalar(a, want) >= 0
    case 'contains': return fold(String(a)).includes(fold(String(want)))
    case 'startsWith': return fold(String(a)).startsWith(fold(String(want)))
    case 'in': return Array.isArray(want) && want.some(w => eq(a, w))
  }
  return false
}

/** Tri stable ; les vides a la fin, quel que soit le sens ; puis par id. */
export function sortRows(rows: QueryRow[], sort: QuerySort[], formula: FormulaLookup): QueryRow[] {
  const keyed = rows.map(row => ({ row, keys: sort.map(s => { const v = fieldOf(row, s.field, formula); return Array.isArray(v) ? v[0] : v }) }))
  keyed.sort((x, y) => {
    for (let i = 0; i < sort.length; i++) {
      const a = x.keys[i], b = y.keys[i]
      const ea = isEmpty(a), eb = isEmpty(b)
      if (ea || eb) { if (ea !== eb) return ea ? 1 : -1; continue }
      const c = compareScalar(a as PropertyValue, b as PropertyValue)
      if (c !== 0) return sort[i].dir === 'desc' ? -c : c
    }
    return x.row.id < y.row.id ? -1 : x.row.id > y.row.id ? 1 : 0
  })
  return keyed.map(k => k.row)
}

function groupsOf(rows: QueryRow[], field: QueryField, formula: FormulaLookup): QueryGroup[] {
  const counts = new Map<string, { key: PropertyValue; count: number }>()
  for (const row of rows) {
    const v = fieldOf(row, field, formula)
    const keys: PropertyValue[] = isEmpty(v) ? [null] : Array.isArray(v) ? v : [v as PropertyValue]
    for (const k of keys) {
      const id = JSON.stringify(k)
      const g = counts.get(id)
      if (g) g.count++
      else counts.set(id, { key: k, count: 1 })
    }
  }
  return [...counts.values()].sort((a, b) => b.count - a.count)
}

// ── Le moteur ────────────────────────────────────────────────────────────

/**
 * Le moteur, plus les formules : les requetes qui n'en parlent pas lui
 * passent telles quelles.
 */
export function withFormulas(inner: IQueryEngine, formula: FormulaLookup): IQueryEngine {
  /** Lignes lues pour une requete de base, gardees jusqu'au prochain changement de l'index. */
  const cache = new Map<string, Promise<{ rows: QueryRow[]; truncated: boolean; index: IndexState }>>()
  const baseOf = (q: Query): Query => {
    const { engine } = splitWhere(q.where)
    const clientSort = q.sort?.some(s => isFormulaField(s.field))
    return { from: q.from, where: engine, text: q.text, ...(clientSort ? {} : { sort: q.sort }), select: q.select }
  }
  const rowsOf = (base: Query) => {
    const key = JSON.stringify(base)
    let p = cache.get(key)
    if (!p) {
      p = fetchBaseRows(inner, base).then(r => ({ ...r, index: inner.state() }))
      p.catch(() => cache.delete(key))
      if (cache.size > 20) cache.clear()
      cache.set(key, p)
    }
    return p
  }
  const run = async (q: Query): Promise<QueryResult> => {
    const base = baseOf(q)
    const { rows, index } = await rowsOf(base)
    const { client } = splitWhere(q.where)
    let kept = client ? rows.filter(r => matchRow(r, client, formula)) : rows
    if (q.sort?.some(s => isFormulaField(s.field))) kept = sortRows(kept, q.sort, formula)
    const limit = Math.max(1, Math.min(q.limit ?? 50, 500))
    const offset = q.cursor ? Number(q.cursor.replace(/^f:/, '')) || 0 : 0
    const page = kept.slice(offset, offset + limit)
    return {
      rows: page,
      next: offset + limit < kept.length ? `f:${offset + limit}` : undefined,
      total: kept.length,
      ...(q.groupBy ? { groups: groupsOf(kept, q.groupBy, formula) } : {}),
      index,
    }
  }
  return {
    query: (q, options) => needsFormulas(q) ? run(q) : inner.query(q, options),
    watch(q, cb) {
      if (!needsFormulas(q)) return inner.watch(q, cb)
      const base = baseOf(q)
      let stopped = false
      let pending: ReturnType<typeof setTimeout> | null = null
      // La plus petite requete suivie sert de signal : a chaque changement,
      // on relit les lignes et on recalcule.
      const stop = inner.watch({ ...base, limit: 1 }, () => {
        cache.delete(JSON.stringify(base))
        if (pending) clearTimeout(pending)
        pending = setTimeout(() => {
          pending = null
          void run(q).then(r => { if (!stopped) cb(r) }, err => console.warn('[plugin-base] formules', err))
        }, 60)
      })
      return () => { stopped = true; if (pending) clearTimeout(pending); stop() }
    },
    state: () => inner.state(),
    onStateChange: cb => inner.onStateChange(cb),
  }
}
