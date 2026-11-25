// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Arguments des outils d'agent des bases (agentTools.ts), lus et verifies :
//  - un filtre { property, op, value }, combinable par { and: [...] } et
//    { or: [...] }, traduit en filtre du moteur de requetes (query.ts) avec
//    les memes regles que les filtres des vues (filters.ts : une date se
//    compare au jour) ;
//  - des tris [{ property, direction }] ;
//  - une valeur de cellule, ramenee au type declare de la propriete.
// Une IA se trompe : chaque erreur dit ce qui est attendu.
import { AUTO_PROPERTY_TYPES, guessPropertyType, isListType } from '@savoire/plugin-api'
import type { PropertyDef, PropertyType, PropertyValue, QueryField, QueryFilter, QuerySort } from '@savoire/plugin-api'
import { toWhere, type BaseFilterOp, type FilterContext } from './filters'
import { TITLE_COLUMN, isFormulaKey } from './manifest'

export const FILTER_OPS = ['eq', 'neq', 'contains', 'gt', 'lt', 'gte', 'lte', 'empty', 'not_empty'] as const
export type ToolFilterOp = typeof FILTER_OPS[number]

/** Filtres simples au plus dans une requete, et profondeur des groupes. */
export const MAX_FILTERS = 50
export const MAX_FILTER_NESTING = 4
export const MAX_SORTS = 5

export interface ArgContext {
  /** Proprietes de la base : « Nom » designe le titre, sauf si une propriete porte ce nom. */
  keys: readonly string[]
  /** Type d'une propriete (declare, sinon devine). */
  typeOf(key: string): PropertyType
  /** Id de la personne (« @me » dans un filtre). */
  me?: string
  now?: Date
}

const TITLE_NAMES: ReadonlySet<string> = new Set(['nom', 'name'])

/** Le nom donne designe-t-il le titre de la ligne ? */
export function isTitleName(name: string, keys: readonly string[]): boolean {
  return name === TITLE_COLUMN || (TITLE_NAMES.has(name.toLowerCase()) && !keys.includes(name))
}

function fieldOf(name: string, keys: readonly string[]): QueryField {
  if (isTitleName(name, keys)) return { doc: 'title' }
  if (name === '@created') return { doc: 'created' }
  if (name === '@modified') return { doc: 'modified' }
  return { prop: name }
}

const TRUE_RE = /^(true|vrai|oui|yes)$/i
const FALSE_RE = /^(false|faux|non|no)$/i

function filterValue(property: string, type: PropertyType, raw: unknown): PropertyValue {
  if (raw === undefined || raw === null || raw === '') throw new Error(`Filtre sur « ${property} » : donnez une valeur (value), ou l’opérateur empty / not_empty.`)
  if (typeof raw !== 'string' && typeof raw !== 'number' && typeof raw !== 'boolean') throw new Error(`Filtre sur « ${property} » : la valeur est un texte, un nombre ou un booléen.`)
  if (type === 'number' && typeof raw === 'string' && raw.trim() !== '' && Number.isFinite(Number(raw))) return Number(raw)
  if (type === 'checkbox' && typeof raw === 'string') return TRUE_RE.test(raw.trim()) ? true : FALSE_RE.test(raw.trim()) ? false : raw
  return raw
}

/**
 * Le filtre d'un outil -> celui du moteur. Rend aussi les proprietes visees,
 * pour signaler une faute de nom quand rien ne sort.
 */
export function parseFilter(raw: unknown, ctx: ArgContext): { where?: QueryFilter; properties: string[] } {
  if (raw === undefined || raw === null) return { properties: [] }
  const properties = new Set<string>()
  const fctx: FilterContext = { now: ctx.now, me: ctx.me, typeOf: ctx.typeOf, field: key => fieldOf(key, ctx.keys) }
  let count = 0
  const walk = (node: unknown, depth: number): QueryFilter | undefined => {
    if (!node || typeof node !== 'object' || Array.isArray(node)) throw new Error('Filtre illisible. Attendu : { property, op, value }, { and: [...] } ou { or: [...] }.')
    const o = node as Record<string, unknown>
    const mode = Array.isArray(o.and) ? 'and' : Array.isArray(o.or) ? 'or' : null
    if (mode) {
      if (depth >= MAX_FILTER_NESTING) throw new Error(`Filtre trop imbriqué : ${MAX_FILTER_NESTING} niveaux au plus.`)
      const parts = (o[mode] as unknown[]).map(x => walk(x, depth + 1)).filter((x): x is QueryFilter => !!x)
      if (!parts.length) return undefined
      return parts.length === 1 ? parts[0] : mode === 'or' ? { or: parts } : { and: parts }
    }
    if (++count > MAX_FILTERS) throw new Error(`Trop de filtres : ${MAX_FILTERS} au plus.`)
    const property = typeof o.property === 'string' ? o.property.trim() : ''
    if (!property) throw new Error('Filtre sans propriété (property).')
    if (!(FILTER_OPS as readonly unknown[]).includes(o.op)) throw new Error(`Opérateur inconnu : ${String(o.op)}. Possibles : ${FILTER_OPS.join(', ')}.`)
    if (isFormulaKey(property)) throw new Error(`« ${property} » est une colonne calculée : pas de filtre dessus ici.`)
    const title = isTitleName(property, ctx.keys)
    if (!title && !property.startsWith('@')) properties.add(property)
    const key = title ? TITLE_COLUMN : property
    const op = (o.op === 'not_empty' ? 'notEmpty' : o.op) as BaseFilterOp
    if (op === 'empty' || op === 'notEmpty') return toWhere([{ key, op }], 'and', fctx)
    const where = toWhere([{ key, op, value: filterValue(property, title ? 'text' : ctx.typeOf(property), o.value) }], 'and', fctx)
    if (!where) throw new Error(`Filtre sur « ${property} » : valeur illisible.`)
    return where
  }
  const where = walk(raw, 0)
  return { ...(where ? { where } : {}), properties: [...properties] }
}

/** Les tris d'un outil -> ceux du moteur. Aucun : par nom. */
export function parseSorts(raw: unknown, ctx: Pick<ArgContext, 'keys'>): QuerySort[] {
  if (raw === undefined || raw === null) return [{ field: { doc: 'title' } }]
  if (!Array.isArray(raw)) throw new Error('Tris illisibles. Attendu : [{ property, direction }].')
  if (raw.length > MAX_SORTS) throw new Error(`Trop de tris : ${MAX_SORTS} au plus.`)
  const sorts = raw.map((x): QuerySort => {
    const o = (x && typeof x === 'object' ? x : {}) as Record<string, unknown>
    const property = typeof o.property === 'string' ? o.property.trim() : ''
    if (!property) throw new Error('Tri sans propriété (property).')
    if (isFormulaKey(property)) throw new Error(`« ${property} » est une colonne calculée : pas de tri dessus ici.`)
    const d = o.direction === undefined || o.direction === null ? 'asc' : String(o.direction).toLowerCase()
    if (!['asc', 'desc', 'ascending', 'descending'].includes(d)) throw new Error(`Sens de tri inconnu : ${String(o.direction)}. Possibles : asc, desc.`)
    return { field: fieldOf(property, ctx.keys), dir: d.startsWith('desc') ? 'desc' : 'asc' }
  })
  return sorts.length ? sorts : [{ field: { doc: 'title' } }]
}

const scalar = (v: unknown): v is string | number | boolean => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean'

/**
 * Une valeur donnee par une IA -> la valeur de la cellule. null : effacer.
 * Avec un type declare, la valeur y est ramenee ou refusee ; sans, elle est
 * gardee telle quelle (texte, nombre, booleen, liste de textes).
 */
export function parseCell(key: string, def: Pick<PropertyDef, 'type' | 'multiple'> | undefined, raw: unknown): PropertyValue {
  if (isFormulaKey(key)) throw new Error(`« ${key} » est une colonne calculée : elle ne se remplit pas.`)
  if (def && AUTO_PROPERTY_TYPES.includes(def.type)) throw new Error(`« ${key} » est remplie par Savoire (${def.type}) : ne la donnez pas.`)
  if (raw === undefined || raw === null || raw === '' || (Array.isArray(raw) && raw.length === 0)) return null
  const bad = (expected: string): never => { throw new Error(`« ${key} » : ${expected} attendu, reçu ${JSON.stringify(raw)}.`) }
  if (Array.isArray(raw)) {
    if (!raw.every(scalar)) return bad('une liste de textes')
    if (def && !isListType(def.type, def)) return bad('une seule valeur')
    return raw.map(String)
  }
  if (!scalar(raw)) return bad('un texte, un nombre, un booléen ou une liste de textes')
  if (!def) return raw
  switch (def.type) {
    case 'number': {
      const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw.trim().replace(',', '.')) : NaN
      return Number.isFinite(n) ? n : bad('un nombre')
    }
    case 'checkbox': {
      if (typeof raw === 'boolean') return raw
      const t = String(raw).trim()
      return TRUE_RE.test(t) || t === '1' ? true : FALSE_RE.test(t) || t === '0' ? false : bad('true ou false')
    }
    case 'date':
      return typeof raw === 'string' && guessPropertyType(raw.trim()) === 'date' ? raw.trim() : bad('une date ISO (2026-11-24, 2026-11-24T10:30, ou début/fin)')
    default:
      return isListType(def.type, def) ? [String(raw)] : String(raw)
  }
}
