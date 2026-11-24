// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Filtres d'une vue (ou de la source) d'une base, comme dans Notion :
//
//  - une liste de filtres reunis par « et » ou par « ou » (filterMode) ;
//  - un element de la liste peut etre un GROUPE, avec sa propre liaison
//    (« (Statut est Fait ou Statut est Annule) et Prix > 10 ») ;
//  - des dates relatives (« aujourd'hui », « cette semaine »...) recalculees
//    a chaque requete, et « moi » pour une personne.
//
// Le manifeste garde les filtres tels quels (JSON) ; toWhere les traduit en
// filtre declaratif du moteur (query.ts) au moment de la requete.
import type { FilterOp, PropertyType, PropertyValue, QueryField, QueryFilter } from '@savoire/plugin-api'

/** « est dans » une periode : propre aux bases, traduit en deux bornes. */
export type BaseFilterOp = FilterOp | 'within'

export interface BaseFilter {
  /** Propriete, ou une colonne du document ('@title', '@created'...). */
  key: string
  op: BaseFilterOp
  value?: PropertyValue
}

export type FilterMode = 'and' | 'or'

export interface BaseFilterGroup {
  mode: FilterMode
  items: BaseFilterItem[]
}

export type BaseFilterItem = BaseFilter | BaseFilterGroup

export function isFilterGroup(f: BaseFilterItem | undefined): f is BaseFilterGroup {
  return !!f && typeof f === 'object' && Array.isArray((f as BaseFilterGroup).items)
}

/** Profondeur maximale des groupes (comme Notion : un groupe dans un groupe). */
export const MAX_FILTER_DEPTH = 2

const OPS: ReadonlySet<string> = new Set(['eq', 'neq', 'lt', 'lte', 'gt', 'gte', 'contains', 'startsWith', 'in', 'empty', 'notEmpty', 'within'])

function cleanValue(v: unknown): PropertyValue | undefined {
  if (v === undefined) return undefined
  if (v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v
  if (Array.isArray(v)) return v.filter(x => typeof x === 'string' || typeof x === 'number').map(String)
  return undefined
}

/** Filtres lus dans le manifeste : ce qui n'a pas la bonne forme est ignore. */
export function readFilters(raw: unknown, depth = 0): BaseFilterItem[] {
  if (!Array.isArray(raw)) return []
  const out: BaseFilterItem[] = []
  for (const x of raw) {
    if (!x || typeof x !== 'object') continue
    const o = x as Record<string, unknown>
    if (Array.isArray(o.items)) {
      if (depth >= MAX_FILTER_DEPTH) continue
      out.push({ mode: o.mode === 'or' ? 'or' : 'and', items: readFilters(o.items, depth + 1) })
      continue
    }
    if (typeof o.key !== 'string' || typeof o.op !== 'string' || !OPS.has(o.op)) continue
    const value = cleanValue(o.value)
    out.push({ key: o.key, op: o.op as BaseFilterOp, ...(value !== undefined ? { value } : {}) })
  }
  return out
}

/** Nombre de filtres simples (groupes compris), pour le bouton « Filtrer (3) ». */
export function countFilters(items: readonly BaseFilterItem[]): number {
  return items.reduce((n, f) => n + (isFilterGroup(f) ? countFilters(f.items) : 1), 0)
}

/** Toutes les cles visees (pour suivre un renommage de propriete). */
export function mapFilterKeys(items: readonly BaseFilterItem[], fn: (key: string) => string | null): BaseFilterItem[] {
  const out: BaseFilterItem[] = []
  for (const f of items) {
    if (isFilterGroup(f)) { out.push({ ...f, items: mapFilterKeys(f.items, fn) }); continue }
    const key = fn(f.key)
    if (key !== null) out.push({ ...f, key })
  }
  return out
}

// ── Dates relatives ──────────────────────────────────────────────────────

/** Jours relatifs : valeur d'un filtre de date (« est aujourd'hui »). */
export const RELATIVE_DAYS: { value: string; label: string }[] = [
  { value: '@today', label: 'Aujourd’hui' },
  { value: '@yesterday', label: 'Hier' },
  { value: '@tomorrow', label: 'Demain' },
]

/** Periodes : valeur d'un filtre « est dans ». */
export const DATE_RANGES: { value: string; label: string }[] = [
  { value: '@thisWeek', label: 'Cette semaine' },
  { value: '@pastWeek', label: 'Les 7 derniers jours' },
  { value: '@nextWeek', label: 'Les 7 prochains jours' },
  { value: '@thisMonth', label: 'Ce mois-ci' },
  { value: '@pastMonth', label: 'Les 30 derniers jours' },
  { value: '@nextMonth', label: 'Les 30 prochains jours' },
  { value: '@thisYear', label: 'Cette année' },
  { value: '@pastYear', label: 'Les 12 derniers mois' },
  { value: '@nextYear', label: 'Les 12 prochains mois' },
]

/** « Moi » : la personne connectee, pour une propriete de type personne. */
export const ME = '@me'

const pad = (n: number) => String(n).padStart(2, '0')

/** Jour local 'YYYY-MM-DD'. */
export function isoDay(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function addDays(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n)
}

function parseDay(s: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s)
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null
}

/**
 * Le jour vise par une valeur de filtre de date : un jour relatif, ou une
 * date 'YYYY-MM-DD'. Null : pas un jour (date-heure, texte).
 */
export function dayOf(value: PropertyValue | undefined, now: Date): Date | null {
  if (typeof value !== 'string') return null
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  switch (value) {
    case '@today': return today
    case '@yesterday': return addDays(today, -1)
    case '@tomorrow': return addDays(today, 1)
  }
  return parseDay(value)
}

/** Bornes [debut, fin) d'une periode, en jours 'YYYY-MM-DD'. Null : periode inconnue. */
export function rangeOf(value: PropertyValue | undefined, now: Date): [string, string] | null {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const day = dayOf(value, now)
  if (day) return [isoDay(day), isoDay(addDays(day, 1))]
  switch (value) {
    case '@thisWeek': {
      // Semaine du lundi au dimanche.
      const monday = addDays(today, -((today.getDay() + 6) % 7))
      return [isoDay(monday), isoDay(addDays(monday, 7))]
    }
    case '@pastWeek': return [isoDay(addDays(today, -6)), isoDay(addDays(today, 1))]
    case '@nextWeek': return [isoDay(today), isoDay(addDays(today, 7))]
    case '@thisMonth': return [isoDay(new Date(today.getFullYear(), today.getMonth(), 1)), isoDay(new Date(today.getFullYear(), today.getMonth() + 1, 1))]
    case '@pastMonth': return [isoDay(addDays(today, -29)), isoDay(addDays(today, 1))]
    case '@nextMonth': return [isoDay(today), isoDay(addDays(today, 30))]
    case '@thisYear': return [`${today.getFullYear()}-01-01`, `${today.getFullYear() + 1}-01-01`]
    case '@pastYear': return [isoDay(new Date(today.getFullYear() - 1, today.getMonth(), today.getDate() + 1)), isoDay(addDays(today, 1))]
    case '@nextYear': return [isoDay(today), isoDay(new Date(today.getFullYear() + 1, today.getMonth(), today.getDate()))]
  }
  return null
}

/** Libelle d'une valeur relative, pour l'affichage. */
export function relativeLabel(value: PropertyValue | undefined): string | null {
  if (value === ME) return 'Moi'
  return [...RELATIVE_DAYS, ...DATE_RANGES].find(r => r.value === value)?.label ?? null
}

// ── Traduction pour le moteur ────────────────────────────────────────────

export interface FilterContext {
  /** Maintenant (dates relatives) ; defaut : l'heure de la requete. */
  now?: Date
  /** Id de la personne connectee (« moi ») ; absent : « moi » ne trouve rien. */
  me?: string
  /** Type d'une propriete : une date se compare jour par jour. */
  typeOf?(key: string): PropertyType
  /** Champ du moteur pour une cle ; defaut : la propriete, ou le titre pour '@title'. */
  field?(key: string): QueryField
}

const NEVER = '\u0000'

function defaultField(key: string): QueryField {
  return key === '@title' ? { doc: 'title' } : { prop: key }
}

const DOC_DATES = new Set(['@created', '@modified'])

function leaf(f: BaseFilter, ctx: FilterContext): QueryFilter | null {
  if (!f.key) return null
  const field = (ctx.field ?? defaultField)(f.key)
  const now = ctx.now ?? new Date()
  let value = f.value
  if (value === ME) value = ctx.me || NEVER
  if (f.op === 'empty' || f.op === 'notEmpty') return { field, op: f.op }
  // Filtre sans valeur (en cours de saisie) : il ne filtre rien, comme dans Notion.
  if (value === undefined || value === null || value === '' || (Array.isArray(value) && value.length === 0)) return null
  const isDate = DOC_DATES.has(f.key) || ctx.typeOf?.(f.key) === 'date'
  if (f.op === 'within') {
    const r = rangeOf(value, now)
    if (!r) return null
    return { and: [{ field, op: 'gte', value: r[0] }, { field, op: 'lt', value: r[1] }] }
  }
  // Une date se compare au jour : « est le 24 » vaut aussi pour 24 a 10 h.
  if (isDate || (typeof value === 'string' && value.startsWith('@'))) {
    const day = dayOf(value, now)
    if (day) {
      const start = isoDay(day)
      const end = isoDay(addDays(day, 1))
      switch (f.op) {
        case 'eq': return { and: [{ field, op: 'gte', value: start }, { field, op: 'lt', value: end }] }
        case 'neq': return { and: [{ field, op: 'notEmpty' }, { not: { and: [{ field, op: 'gte', value: start }, { field, op: 'lt', value: end }] } }] }
        case 'lt': return { field, op: 'lt', value: start }
        case 'lte': return { field, op: 'lt', value: end }
        case 'gt': return { field, op: 'gte', value: end }
        case 'gte': return { field, op: 'gte', value: start }
      }
    }
  }
  return { field, op: f.op, value: value ?? undefined }
}

function join(parts: QueryFilter[], mode: FilterMode): QueryFilter | undefined {
  if (parts.length === 0) return undefined
  if (parts.length === 1) return parts[0]
  return mode === 'or' ? { or: parts } : { and: parts }
}

/**
 * Filtres d'une vue -> filtre du moteur. Un filtre incomplet (sans
 * propriete, periode inconnue) est ignore ; un groupe vide aussi.
 */
export function toWhere(items: readonly BaseFilterItem[] | undefined, mode: FilterMode = 'and', ctx: FilterContext = {}): QueryFilter | undefined {
  const parts: QueryFilter[] = []
  for (const f of items ?? []) {
    const q = isFilterGroup(f) ? toWhere(f.items, f.mode, ctx) : leaf(f, ctx)
    if (q) parts.push(q)
  }
  return join(parts, mode)
}
