// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Evaluation de reference d'une requete declarative sur des documents deja
// en memoire : la semantique de query.ts, en JavaScript. Le moteur en memoire
// l'utilise pour tout ; les moteurs SQLite pour ce que SQL ne sait pas
// faire : les champs calcules par une formule ({ formula }).
//
// Rien ici ne lit un index : on lui donne les documents, il filtre, trie,
// groupe et agrege.
import { compileFormula, FormulaError, FORMULA_MAX_LENGTH } from './formula'
import type { CompiledFormula } from './formula'
import type { PropertyValue } from './properties'
import type { Query, QueryAggregate, QueryField, QueryFilter, QueryGroup, QuerySort } from './query'

/** Formules distinctes au plus dans une requete. */
export const QUERY_MAX_FORMULAS = 8

/** Un document tel qu'une requete le voit. */
export interface EvalDoc {
  id: string
  /** Chemin de la note ; vide pour une ligne legere. */
  path: string
  title: string
  props: Record<string, PropertyValue>
  created?: string
  modified?: string
}

/** Requete refusee pendant l'evaluation (code de QueryErrorInfo). */
export class QueryEvalError extends Error {
  constructor(readonly code: 'invalid_query' | 'too_complex', message: string) {
    super(message)
  }
}

/** Minuscules, sans accents : les comparaisons de texte n'en tiennent pas compte. */
export function foldText(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
}

// Les memes valeurs reviennent sans cesse (statuts, choix) : on garde leur
// forme repliee. Borne pour ne pas grossir sans fin.
const foldCache = new Map<string, string>()
function fold(s: string): string {
  let f = foldCache.get(s)
  if (f === undefined) {
    if (foldCache.size > 200_000) foldCache.clear()
    f = foldText(s)
    foldCache.set(s, f)
  }
  return f
}

export function isEmptyValue(v: PropertyValue | undefined): boolean {
  return v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0)
}

function folderOf(path: string): string {
  const i = path.lastIndexOf('/')
  return i < 0 ? '' : path.slice(0, i)
}

function extOf(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1)
  const i = name.lastIndexOf('.')
  return i <= 0 ? '' : name.slice(i + 1).toLowerCase()
}

// ── Formules ──────────────────────────────────────────────────────────────

function eachField(q: Query, cb: (f: QueryField) => void): void {
  const walk = (f: QueryFilter | undefined): void => {
    if (!f) return
    if ('and' in f) f.and.forEach(walk)
    else if ('or' in f) f.or.forEach(walk)
    else if ('not' in f) walk(f.not)
    else cb(f.field)
  }
  walk(q.where)
  if (q.from && 'base' in q.from) walk(q.from.pages?.where)
  for (const s of q.sort ?? []) cb(s.field)
  if (q.groupBy) cb(q.groupBy)
  for (const a of q.aggregate ?? []) if (a.field) cb(a.field)
}

export const isFormulaField = (f: QueryField | undefined): f is { formula: string } =>
  !!f && typeof f === 'object' && 'formula' in f

function filterUsesFormula(f: QueryFilter | undefined): boolean {
  if (!f) return false
  if ('and' in f) return f.and.some(filterUsesFormula)
  if ('or' in f) return f.or.some(filterUsesFormula)
  if ('not' in f) return filterUsesFormula(f.not)
  return isFormulaField(f.field)
}

/** La requete a-t-elle un champ calcule par une formule ? */
export function queryUsesFormula(q: Query): boolean {
  let found = false
  eachField(q, f => { if (isFormulaField(f)) found = true })
  return found
}

/**
 * Coupe un filtre : la part sans formule (que SQL sait faire) et le reste.
 * Seul un « et » de premier niveau se coupe ; un « ou » ou un « non » qui
 * touche une formule part entier dans le reste.
 */
export function splitFormulaFilter(where: QueryFilter | undefined): { plain?: QueryFilter; formula?: QueryFilter } {
  if (!where) return {}
  if (!filterUsesFormula(where)) return { plain: where }
  if (!('and' in where)) return { formula: where }
  const join = (xs: QueryFilter[]) => xs.length === 0 ? undefined : xs.length === 1 ? xs[0] : { and: xs }
  return { plain: join(where.and.filter(f => !filterUsesFormula(f))), formula: join(where.and.filter(filterUsesFormula)) }
}

/** Lit la valeur d'un champ ; compile chaque formule une fois. */
export class FieldReader {
  private readonly formulas = new Map<string, CompiledFormula>()

  /** Verifie et compile les formules de la requete. Lance QueryEvalError. */
  constructor(query: Query) {
    eachField(query, f => {
      if (!isFormulaField(f)) return
      const src = f.formula
      if (typeof src !== 'string' || !src.trim()) throw new QueryEvalError('invalid_query', 'formula : expression attendue.')
      if (src.length > FORMULA_MAX_LENGTH) throw new QueryEvalError('too_complex', `formula : ${FORMULA_MAX_LENGTH} caracteres au plus.`)
      if (this.formulas.has(src)) return
      if (this.formulas.size >= QUERY_MAX_FORMULAS) throw new QueryEvalError('too_complex', `Trop de formules (${QUERY_MAX_FORMULAS} au plus).`)
      try {
        this.formulas.set(src, compileFormula(src))
      } catch (err) {
        throw new QueryEvalError('invalid_query', `formula : ${err instanceof FormulaError ? err.message : String(err)}`)
      }
    })
  }

  value(doc: EvalDoc, field: QueryField): PropertyValue | undefined {
    if ('prop' in field) return doc.props[field.prop]
    if ('formula' in field) {
      const f = this.formulas.get(field.formula)
      if (!f) return undefined
      // Une formule en erreur sur une ligne : valeur vide pour cette ligne.
      const r = f.evaluate({ title: doc.title, values: doc.props })
      return r.ok ? r.value : null
    }
    switch (field.doc) {
      case 'path': return doc.path
      case 'title': return doc.title
      case 'folder': return folderOf(doc.path)
      case 'ext': return extOf(doc.path)
      case 'created': return doc.created
      case 'modified': return doc.modified
    }
    return undefined
  }
}

// ── Filtres ───────────────────────────────────────────────────────────────

/** Comparaison de deux valeurs non vides du meme genre ; texte replie. */
export function compareScalar(a: PropertyValue, b: PropertyValue): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b
  if (typeof a === 'boolean' && typeof b === 'boolean') return Number(a) - Number(b)
  const fa = fold(String(a))
  const fb = fold(String(b))
  return fa < fb ? -1 : fa > fb ? 1 : 0
}

function scalarEquals(a: PropertyValue, b: PropertyValue): boolean {
  return compareScalar(a, b) === 0
}

export function matchesDoc(reader: FieldReader, doc: EvalDoc, filter: QueryFilter): boolean {
  if ('and' in filter) return filter.and.every(f => matchesDoc(reader, doc, f))
  if ('or' in filter) return filter.or.some(f => matchesDoc(reader, doc, f))
  if ('not' in filter) return !matchesDoc(reader, doc, filter.not)
  const v = reader.value(doc, filter.field)
  const want = filter.value
  switch (filter.op) {
    case 'empty': return isEmptyValue(v)
    case 'notEmpty': return !isEmptyValue(v)
  }
  if (isEmptyValue(v) || want === undefined || want === null) return false
  const actual = v as PropertyValue
  if (Array.isArray(actual)) {
    // Liste : eq / contains = contient la valeur ; in = intersection.
    switch (filter.op) {
      case 'eq':
      case 'contains': return actual.some(x => scalarEquals(x, want as PropertyValue))
      case 'neq': return !actual.some(x => scalarEquals(x, want as PropertyValue))
      case 'in': return Array.isArray(want) && actual.some(x => want.some(w => scalarEquals(x, w)))
      default: return false
    }
  }
  switch (filter.op) {
    case 'eq': return scalarEquals(actual, want)
    case 'neq': return !scalarEquals(actual, want)
    case 'lt': return compareScalar(actual, want) < 0
    case 'lte': return compareScalar(actual, want) <= 0
    case 'gt': return compareScalar(actual, want) > 0
    case 'gte': return compareScalar(actual, want) >= 0
    case 'contains': return fold(String(actual)).includes(fold(String(want)))
    case 'startsWith': return fold(String(actual)).startsWith(fold(String(want)))
    case 'in': return Array.isArray(want) && want.some(w => scalarEquals(actual, w))
  }
  return false
}

// ── Tri ───────────────────────────────────────────────────────────────────

/** Cle de tri precalculee d'une valeur : evite de replier le texte a chaque comparaison. */
interface SortKey { empty: boolean; raw: PropertyValue; folded: string }

function sortKey(v: PropertyValue | undefined): SortKey {
  if (isEmptyValue(v)) return { empty: true, raw: null, folded: '' }
  const raw = Array.isArray(v) ? v[0] : v as PropertyValue
  return { empty: false, raw, folded: typeof raw === 'number' || typeof raw === 'boolean' ? '' : fold(String(raw)) }
}

function compareKeys(a: SortKey, b: SortKey): number {
  if (typeof a.raw === 'number' && typeof b.raw === 'number') return a.raw - b.raw
  if (typeof a.raw === 'boolean' && typeof b.raw === 'boolean') return Number(a.raw) - Number(b.raw)
  const fa = a.folded || fold(String(a.raw))
  const fb = b.folded || fold(String(b.raw))
  return fa < fb ? -1 : fa > fb ? 1 : 0
}

/** Trie en place : vides en dernier quel que soit le sens, puis par id. Sans tri : par id. */
export function sortDocs<T extends EvalDoc>(reader: FieldReader, docs: T[], sort: readonly QuerySort[]): T[] {
  if (sort.length === 0) return docs.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  const keyed = docs.map(doc => ({ doc, keys: sort.map(s => sortKey(reader.value(doc, s.field))) }))
  keyed.sort((a, b) => {
    for (let i = 0; i < sort.length; i++) {
      const ka = a.keys[i], kb = b.keys[i]
      if (ka.empty !== kb.empty) return ka.empty ? 1 : -1
      if (ka.empty) continue
      const c = compareKeys(ka, kb)
      if (c !== 0) return sort[i].dir === 'desc' ? -c : c
    }
    return a.doc.id < b.doc.id ? -1 : a.doc.id > b.doc.id ? 1 : 0
  })
  for (let i = 0; i < keyed.length; i++) docs[i] = keyed[i].doc
  return docs
}

// ── Groupes et agregats ───────────────────────────────────────────────────

/** Comptes par valeur (un par element d'une liste) ; les plus nombreux d'abord, vide en dernier. */
export function groupDocs(reader: FieldReader, docs: readonly EvalDoc[], field: QueryField): QueryGroup[] {
  const counts = new Map<string, QueryGroup>()
  for (const doc of docs) {
    const v = reader.value(doc, field)
    const keys: PropertyValue[] = isEmptyValue(v) ? [null] : Array.isArray(v) ? v : [v as PropertyValue]
    for (const key of keys) {
      const id = JSON.stringify(key)
      const g = counts.get(id) ?? { key, count: 0 }
      g.count++
      counts.set(id, g)
    }
  }
  return [...counts.values()].sort((a, b) =>
    b.count - a.count
    || Number(a.key === null) - Number(b.key === null)
    || (a.key === null || b.key === null ? 0 : compareScalar(a.key as PropertyValue, b.key as PropertyValue)))
}

const AGGREGATE_OPS = new Set(['count', 'sum', 'mean', 'min', 'max'])

/** Verifie les agregats d'une requete. Lance QueryEvalError. */
export function checkAggregates(list: unknown, max: number): void {
  if (list === undefined) return
  if (!Array.isArray(list) || list.length > max) throw new QueryEvalError('too_complex', `Trop d'agregats (${max} au plus).`)
  for (const a of list as QueryAggregate[]) {
    if (!AGGREGATE_OPS.has(a?.op)) throw new QueryEvalError('invalid_query', `Agregat inconnu : ${String(a?.op)}.`)
    if (a.op !== 'count' && !a.field) throw new QueryEvalError('invalid_query', `${a.op} : champ attendu.`)
  }
}

/** Un agregat sur des documents (semantique : QueryAggregate). */
export function aggregateDocs(reader: FieldReader, docs: readonly EvalDoc[], a: QueryAggregate): PropertyValue {
  if (a.op === 'count') return a.field ? docs.filter(d => !isEmptyValue(reader.value(d, a.field!))).length : docs.length
  const nums: number[] = []
  const texts: string[] = []
  for (const d of docs) {
    const v = reader.value(d, a.field!)
    if (typeof v === 'number' && Number.isFinite(v)) nums.push(v)
    else if (typeof v === 'string' && v !== '') texts.push(v)
  }
  switch (a.op) {
    case 'sum': return nums.reduce((x, y) => x + y, 0)
    case 'mean': return nums.length ? nums.reduce((x, y) => x + y, 0) / nums.length : null
    case 'min':
    case 'max': {
      if (nums.length) return nums.reduce((x, y) => (a.op === 'min' ? y < x : y > x) ? y : x)
      if (!texts.length) return null
      return texts.reduce((x, y) => (a.op === 'min' ? y < x : y > x) ? y : x)
    }
  }
  return null
}
