// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Filtres declaratifs (QueryFilter) -> SQL PARAMETRE. Aucun texte venu de la
// requete n'entre dans le SQL : noms de proprietes et valeurs sont des
// parametres ; seuls les noms de colonnes des champs du document (liste
// fermee) et les operateurs (liste fermee) sont ecrits dans la requete.
//
// Memes regles que le moteur de reference (InMemoryQueryEngine) :
//  - une valeur vide ne satisfait aucune comparaison (sauf empty) ;
//  - texte compare replie (casse, accents) : on compare la copie repliee
//    `txt`, calculee en JS a l'ecriture ;
//  - un nombre se compare en nombre a un nombre, sinon tout se compare en
//    texte replie (String(valeur)), comme compareScalar ;
//  - liste : eq / contains = contient ; neq = ne contient pas ; in = au
//    moins une ; les autres operateurs ne valent rien sur une liste.
// Chaque condition rend 0 ou 1, jamais NULL : NOT reste juste.
//
// Proprietes : table `props` (pouvoir query), une ligne par valeur (une par
// element d'une liste), alias `p`. Document : table `docs`, alias `d`.
import type { FilterOp, PropertyValue, QueryField, QueryFilter } from '@savoire/plugin-api'
import type { SqlValue } from '../driver'
import { IndexError, invalid } from '../errors'
import { foldText } from '../text'

export interface Frag {
  sql: string
  params: SqlValue[]
}

export const TRUE: Frag = { sql: '1', params: [] }
export const FALSE: Frag = { sql: '0', params: [] }

export function and(parts: Frag[]): Frag {
  const kept = parts.filter(p => p.sql !== '1')
  if (kept.length === 0) return TRUE
  if (kept.length === 1) return kept[0]
  return { sql: '(' + kept.map(p => p.sql).join(' AND ') + ')', params: kept.flatMap(p => p.params) }
}

export function or(parts: Frag[]): Frag {
  if (parts.length === 0) return FALSE
  if (parts.length === 1) return parts[0]
  return { sql: '(' + parts.map(p => p.sql).join(' OR ') + ')', params: parts.flatMap(p => p.params) }
}

/** Colonnes des champs du document : brute, et repliee (NULL si vide). */
export const DOC_FIELDS: Readonly<Record<string, { raw: string; fold: string }>> = {
  path: { raw: 'd.path', fold: 'd.path_fold' },
  title: { raw: 'd.title', fold: 'd.title_fold' },
  folder: { raw: 'd.folder', fold: 'd.folder_fold' },
  ext: { raw: 'd.ext', fold: 'd.ext_fold' },
  created: { raw: 'd.created', fold: 'd.created_fold' },
  modified: { raw: 'd.modified', fold: 'd.modified_fold' },
}

const OPS: ReadonlySet<string> = new Set<FilterOp>([
  'eq', 'neq', 'lt', 'lte', 'gt', 'gte', 'contains', 'startsWith', 'in', 'empty', 'notEmpty',
])

export const MAX_FILTER_NODES = 64
const MAX_DEPTH = 16
const MAX_IN_VALUES = 200
const MAX_KEY = 256
const MAX_TEXT = 1000

// ── Verification ─────────────────────────────────────────────────────────

export function parseField(v: unknown, what = 'champ'): QueryField {
  const f = v as { prop?: unknown; doc?: unknown } | null
  if (f && typeof f === 'object' && !Array.isArray(f)) {
    if (typeof f.prop === 'string' && f.doc === undefined) {
      if (f.prop.length > MAX_KEY) throw invalid(`${what} : nom de propriete trop long.`)
      return { prop: f.prop }
    }
    if (typeof f.doc === 'string' && f.prop === undefined && f.doc in DOC_FIELDS) {
      return { doc: f.doc as Extract<QueryField, { doc: string }>['doc'] }
    }
  }
  throw invalid(`${what} : { prop } ou { doc: path | title | folder | ext | created | modified } attendu.`)
}

function isScalar(v: unknown): v is string | number | boolean | null {
  return v === null || typeof v === 'string' || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v))
}

function parseValue(v: unknown): PropertyValue | undefined {
  if (v === undefined) return undefined
  if (typeof v === 'string' && v.length > MAX_TEXT) throw invalid(`valeur : ${MAX_TEXT} caracteres au plus.`)
  if (isScalar(v)) return v
  if (Array.isArray(v)) {
    if (v.length > MAX_IN_VALUES) throw new IndexError('too_complex', `Liste de valeurs trop longue (${MAX_IN_VALUES} au plus).`)
    if (v.every(x => isScalar(x) && !(typeof x === 'string' && x.length > MAX_TEXT))) return v as string[]
  }
  throw invalid('valeur : texte, nombre, booleen, null ou liste attendu.')
}

/** Nombre de conditions d'un filtre (meme compte que le moteur de reference). */
export function countNodes(filter: QueryFilter): number {
  if ('and' in filter) return 1 + filter.and.reduce((n, f) => n + countNodes(f), 0)
  if ('or' in filter) return 1 + filter.or.reduce((n, f) => n + countNodes(f), 0)
  if ('not' in filter) return 1 + countNodes(filter.not)
  return 1
}

/** Verifie un filtre venu du reseau. Le compte des noeuds est fait a part (too_complex). */
export function parseFilter(v: unknown, depth = 0): QueryFilter {
  if (depth > MAX_DEPTH) throw new IndexError('too_complex', `Filtre trop profond (${MAX_DEPTH} niveaux au plus).`)
  const f = v as Record<string, unknown> | null
  if (!f || typeof f !== 'object' || Array.isArray(f)) throw invalid('filtre : objet attendu.')
  if ('and' in f || 'or' in f) {
    const list = 'and' in f ? f.and : f.or
    if (!Array.isArray(list)) throw invalid('filtre : and / or attendent une liste.')
    // Compte avant de descendre : un filtre enorme est refuse sans etre lu.
    if (list.length > MAX_FILTER_NODES) throw new IndexError('too_complex', `Filtre trop complexe (plus de ${MAX_FILTER_NODES} conditions).`)
    const items = list.map(x => parseFilter(x, depth + 1))
    return 'and' in f ? { and: items } : { or: items }
  }
  if ('not' in f) return { not: parseFilter(f.not, depth + 1) }
  if (typeof f.op !== 'string' || !OPS.has(f.op)) throw invalid('filtre : operateur inconnu.')
  const value = parseValue(f.value)
  return { field: parseField(f.field), op: f.op as FilterOp, ...(value !== undefined ? { value } : {}) }
}

// ── Compilation ──────────────────────────────────────────────────────────

const folded = (w: PropertyValue): string => foldText(String(w))

/** Une ligne de `props` egale a w (texte replie, ou nombre). Jamais NULL. */
function rowEq(w: PropertyValue): Frag {
  if (typeof w === 'number') {
    return { sql: '((p.num IS NOT NULL AND p.num = ?) OR (p.num IS NULL AND p.txt = ?))', params: [w, folded(w)] }
  }
  return { sql: 'p.txt = ?', params: [folded(w)] }
}

const CMP: Readonly<Record<string, string>> = { lt: '<', lte: '<=', gt: '>', gte: '>=' }

function rowCmp(op: string, w: PropertyValue): Frag {
  const o = CMP[op]
  if (typeof w === 'number') {
    return { sql: `((p.num IS NOT NULL AND p.num ${o} ?) OR (p.num IS NULL AND p.txt ${o} ?))`, params: [w, folded(w)] }
  }
  return { sql: `p.txt ${o} ?`, params: [folded(w)] }
}

/**
 * Les documents qui ont une ligne de la propriete verifiant `cond`.
 * Deux formes, meme sens :
 *  - `lookup` : liste tiree de l'index (key, txt) ou (key, num), pour une
 *    condition selective (egalite, debut) ;
 *  - sinon EXISTS correle, une lecture par cle primaire (doc, key) pour
 *    chaque document candidat : moins cher qu'une longue liste a construire
 *    pour une condition peu selective (comparaison, contient, vide).
 */
function hasProp(key: string, cond?: Frag, opts: { not?: boolean; lookup?: boolean } = {}): Frag {
  const where = `p.key = ?${cond ? ' AND ' + cond.sql : ''}`
  const params = [key, ...(cond?.params ?? [])]
  if (opts.lookup) return { sql: `d.n ${opts.not ? 'NOT IN' : 'IN'} (SELECT p.doc FROM props p WHERE ${where})`, params }
  return { sql: `${opts.not ? 'NOT ' : ''}EXISTS (SELECT 1 FROM props p WHERE p.doc = d.n AND ${where})`, params }
}

function compilePropLeaf(key: string, op: FilterOp, want: PropertyValue | undefined): Frag {
  if (op === 'empty') return hasProp(key, undefined, { not: true })
  if (op === 'notEmpty') return hasProp(key)
  if (want === undefined || want === null) return FALSE
  const scalar = { sql: 'p.list = 0', params: [] }
  const list = { sql: 'p.list = 1', params: [] }
  switch (op) {
    case 'eq':
      return hasProp(key, rowEq(want), { lookup: true })
    case 'contains':
      return hasProp(key, or([
        and([scalar, { sql: 'instr(p.txt, ?) > 0', params: [folded(want)] }]),
        and([list, rowEq(want)]),
      ]))
    case 'neq':
      return or([
        hasProp(key, and([scalar, { sql: 'NOT ' + rowEq(want).sql, params: rowEq(want).params }])),
        and([hasProp(key, list), hasProp(key, and([list, rowEq(want)]), { not: true })]),
      ])
    case 'lt': case 'lte': case 'gt': case 'gte':
      return hasProp(key, and([scalar, rowCmp(op, want)]))
    case 'startsWith': {
      const w = folded(want)
      return hasProp(key, and([scalar, { sql: 'p.txt >= ? AND substr(p.txt, 1, length(?)) = ?', params: [w, w, w] }]), { lookup: true })
    }
    case 'in':
      if (!Array.isArray(want) || want.length === 0) return FALSE
      return hasProp(key, or(want.map(w => rowEq(w))), { lookup: true })
  }
  return FALSE
}

function compileDocLeaf(name: string, op: FilterOp, want: PropertyValue | undefined): Frag {
  const col = DOC_FIELDS[name].fold
  if (op === 'empty') return { sql: `(${col} IS NULL)`, params: [] }
  if (op === 'notEmpty') return { sql: `(${col} IS NOT NULL)`, params: [] }
  if (want === undefined || want === null) return FALSE
  const w = folded(want)
  switch (op) {
    case 'eq': return { sql: `coalesce(${col} = ?, 0)`, params: [w] }
    case 'neq': return { sql: `coalesce(${col} <> ?, 0)`, params: [w] }
    case 'lt': case 'lte': case 'gt': case 'gte':
      return { sql: `coalesce(${col} ${CMP[op]} ?, 0)`, params: [w] }
    case 'contains': return { sql: `coalesce(instr(${col}, ?) > 0, 0)`, params: [w] }
    case 'startsWith': return { sql: `coalesce(substr(${col}, 1, length(?)) = ?, 0)`, params: [w, w] }
    case 'in':
      if (!Array.isArray(want) || want.length === 0) return FALSE
      return { sql: `coalesce(${col} IN (${want.map(() => '?').join(', ')}), 0)`, params: want.map(x => folded(x)) }
  }
  return FALSE
}

/** Filtre -> condition SQL sur `d` (docs). */
export function compileFilter(filter: QueryFilter): Frag {
  if ('and' in filter) return and(filter.and.map(compileFilter))
  if ('or' in filter) return or(filter.or.map(compileFilter))
  if ('not' in filter) {
    const inner = compileFilter(filter.not)
    return { sql: `(NOT ${inner.sql})`, params: inner.params }
  }
  return 'prop' in filter.field
    ? compilePropLeaf(filter.field.prop, filter.op, filter.value)
    : compileDocLeaf(filter.field.doc, filter.op, filter.value)
}

/**
 * Cle de tri d'un champ, colonne `s<i>` : NULL si vide ; sinon le nombre, ou
 * le texte replie (premier element d'une liste). SQLite range les nombres
 * avant le texte. Une propriete est lue par une jointure sur sa cle primaire.
 */
export function sortColumn(field: QueryField, i: number): { join?: Frag; expr: string } {
  if ('prop' in field) {
    return {
      join: { sql: `LEFT JOIN props j${i} ON j${i}.doc = d.n AND j${i}.key = ? AND j${i}.idx = 0`, params: [field.prop] },
      expr: `coalesce(j${i}.num, j${i}.txt)`,
    }
  }
  return { expr: DOC_FIELDS[field.doc].fold }
}
