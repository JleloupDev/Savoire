// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Filtres, tris, groupes et agregats sur des colonnes formules.
//
// Une colonne formule ({ prop: '=Nom' } dans la vue) part au moteur en champ
// { formula } : il la calcule sur toutes les lignes (query.ts, queryEval.ts).
// Repli pour un moteur qui ne connait pas les formules : on lit les lignes
// de la base (BASE_QUERY_MAX_ROWS au plus) et on calcule ici. Meme contrat
// IQueryEngine : le tableau et le kanban ne voient pas la difference.
import type {
  CompiledFormula, IQueryEngine, IndexState, PropertyValue, Query, QueryField, QueryFilter,
  QueryGroup, QueryResult, QueryRow, QuerySort,
} from '@savoire/plugin-api'
import { isFormulaKey } from './manifest'
import { fetchBaseRows } from './queryBlock'

/** La formule d'une cle, compilee ; undefined si elle n'existe pas ou est fausse. */
export type FormulaLookup = (key: string) => CompiledFormula | undefined

const isFormulaField = (f: QueryField): boolean => 'prop' in f && isFormulaKey(f.prop)
const needsAggregate = (q: Query): boolean => !!q.aggregate?.some(a => a.field && isFormulaField(a.field))

function usesFormula(filter: QueryFilter | undefined): boolean {
  if (!filter) return false
  if ('and' in filter) return filter.and.some(usesFormula)
  if ('or' in filter) return filter.or.some(usesFormula)
  if ('not' in filter) return usesFormula(filter.not)
  return isFormulaField(filter.field)
}

/** La requete a-t-elle besoin d'un calcul cote client ? */
export function needsFormulas(q: Query): boolean {
  return usesFormula(q.where) || !!q.sort?.some(s => isFormulaField(s.field)) || (!!q.groupBy && isFormulaField(q.groupBy)) || needsAggregate(q)
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
  if ('formula' in field) return undefined
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
 * La requete pour le moteur : chaque colonne formule ({ prop: '=Nom' })
 * devient { formula } et le moteur la calcule lui-meme, sur toutes les
 * lignes (query.ts). Une formule fausse vaut vide.
 */
export function toEngineQuery(q: Query, formula: FormulaLookup): Query {
  const field = (f: QueryField): QueryField => isFormulaField(f) ? { formula: formula((f as { prop: string }).prop)?.source ?? '""' } : f
  const filter = (w: QueryFilter): QueryFilter => {
    if ('and' in w) return { and: w.and.map(filter) }
    if ('or' in w) return { or: w.or.map(filter) }
    if ('not' in w) return { not: filter(w.not) }
    if (!isFormulaField(w.field)) return w
    // Valeur saisie en texte dans le filtre (« 10 ») face a une formule : un
    // nombre, comme le calcul de la formule.
    const v = w.value
    const value = typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v.replace(',', '.'))) ? Number(v.replace(',', '.')) : v
    return { ...w, field: field(w.field), ...(value !== undefined ? { value } : {}) }
  }
  return {
    ...q,
    ...(q.where ? { where: filter(q.where) } : {}),
    ...(q.sort ? { sort: q.sort.map(s => ({ ...s, field: field(s.field) })) } : {}),
    ...(q.groupBy ? { groupBy: field(q.groupBy) } : {}),
    ...(q.aggregate ? { aggregate: q.aggregate.map(a => a.field ? { ...a, field: field(a.field) } : a) } : {}),
  }
}

const refused = (err: unknown) => (err as { code?: string })?.code === 'invalid_query'

/**
 * Le moteur, plus les colonnes formules : il les calcule lui-meme (champ
 * { formula }). Un moteur qui ne les connait pas (pair plus ancien) : repli
 * sur le calcul dans le client (clientFormulas). Les requetes sans formule
 * lui passent telles quelles.
 */
export function withFormulas(inner: IQueryEngine, formula: FormulaLookup): IQueryEngine {
  const client = clientFormulas(inner, formula)
  /** undefined : pas encore su ; false : le moteur refuse les formules. */
  let engineOk: boolean | undefined
  return {
    async query(q, options) {
      if (!needsFormulas(q)) return inner.query(q, options)
      if (engineOk === false) return client.query(q, options)
      try {
        const r = await inner.query(toEngineQuery(q, formula), options)
        engineOk = true
        return r
      } catch (err) {
        if (engineOk === true || !refused(err)) throw err
        engineOk = false
        return client.query(q, options)
      }
    },
    watch(q, cb) {
      if (!needsFormulas(q)) return inner.watch(q, cb)
      if (engineOk === false) return client.watch(q, cb)
      if (engineOk === true) return inner.watch(toEngineQuery(q, formula), cb)
      let stopped = false
      let stop = () => {}
      void inner.query({ ...toEngineQuery(q, formula), limit: 1 }).then(
        () => { engineOk = true; if (!stopped) stop = inner.watch(toEngineQuery(q, formula), cb) },
        err => { if (refused(err)) engineOk = false; if (!stopped) stop = (engineOk === false ? client : inner).watch(engineOk === false ? q : toEngineQuery(q, formula), cb) },
      )
      return () => { stopped = true; stop() }
    },
    state: () => inner.state(),
    onStateChange: cb => inner.onStateChange(cb),
  }
}

/**
 * Repli : filtres, tris et groupes sur formules calcules ICI, sur les lignes
 * lues (BASE_QUERY_MAX_ROWS au plus).
 */
export function clientFormulas(inner: IQueryEngine, formula: FormulaLookup): IQueryEngine {
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
