// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Groupes d'une vue (tableau groupe, colonnes et sous-groupes d'un kanban) :
// le champ de regroupement (une date se groupe par jour, semaine, mois ou
// annee, par une formule que le moteur calcule), le filtre d'un groupe, son
// libelle et l'ordre des groupes (celui des options, des dates...).
import type { PropertyOption, PropertyType, PropertyValue, QueryField, QueryFilter } from '@savoire/plugin-api'
import { formatDay, valueText } from './cells'

export type DateGrouping = 'day' | 'week' | 'month' | 'year'

export const DATE_GROUPINGS: { value: DateGrouping; label: string }[] = [
  { value: 'day', label: 'Jour' },
  { value: 'week', label: 'Semaine' },
  { value: 'month', label: 'Mois' },
  { value: 'year', label: 'Année' },
]

const DATE_TYPES: ReadonlySet<string> = new Set(['date', 'created', 'modified'])

export function isDateType(type: PropertyType): boolean {
  return DATE_TYPES.has(type)
}

/** Le champ du moteur pour grouper sur `key` (une date : selon `dateGroup`). */
export function groupField(key: string, type: PropertyType, dateGroup?: DateGrouping): QueryField {
  if (key === '@title') return { doc: 'title' }
  if (!isDateType(type) || !dateGroup) return { prop: key }
  const d = `date(slice(prop(${JSON.stringify(key)}), 0, 10))`
  switch (dateGroup) {
    case 'day': return { formula: `formatDate(${d}, "YYYY-MM-DD")` }
    case 'month': return { formula: `formatDate(${d}, "YYYY-MM")` }
    case 'year': return { formula: `formatDate(${d}, "YYYY")` }
    case 'week': return { formula: `concat(format(weekyear(${d})), "-S", if(week(${d}) < 10, "0", ""), format(week(${d})))` }
  }
}

/** Les lignes d'un groupe (null : sans valeur). */
export function groupFilter(field: QueryField, value: PropertyValue): QueryFilter {
  return value === null ? { field, op: 'empty' } : { field, op: 'eq', value }
}

export function groupId(value: PropertyValue): string {
  return JSON.stringify(value)
}

const MONTHS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre']

/** Libelle d'un groupe. */
export function groupLabel(value: PropertyValue, type: PropertyType, dateGroup?: DateGrouping, members?: { id: string; name: string }[]): string {
  if (value === null) return 'Sans valeur'
  if (type === 'checkbox') return value === true || value === 'true' ? 'Cochée' : 'Non cochée'
  if (type === 'person' || type === 'createdBy' || type === 'modifiedBy') return members?.find(m => m.id === value)?.name ?? valueText(value)
  if (isDateType(type) && typeof value === 'string') {
    if (dateGroup === 'year') return value
    if (dateGroup === 'month') {
      const m = /^(\d{4})-(\d{2})$/.exec(value)
      return m ? `${MONTHS[Number(m[2]) - 1]} ${m[1]}` : value
    }
    if (dateGroup === 'week') {
      const m = /^(\d{4})-S(\d{2})$/.exec(value)
      return m ? `Semaine ${Number(m[2])}, ${m[1]}` : value
    }
    return formatDay(value)
  }
  return valueText(value)
}

/**
 * L'ordre des groupes : options declarees d'abord (statut : par groupe),
 * cases cochees avant les autres, dates et nombres croissants, textes par
 * ordre alphabetique ; « sans valeur » a la fin.
 */
export function orderGroups(values: PropertyValue[], type: PropertyType, options: PropertyOption[] = []): PropertyValue[] {
  const seen = new Set<string>()
  const unique = values.filter(v => { const id = groupId(v); if (seen.has(id)) return false; seen.add(id); return true })
  const empty = unique.filter(v => v === null)
  const rest = unique.filter(v => v !== null)
  const rankOf = new Map<string, number>()
  const opts = type === 'status'
    ? [...options].sort((a, b) => ['todo', 'doing', 'done'].indexOf(a.group ?? 'todo') - ['todo', 'doing', 'done'].indexOf(b.group ?? 'todo'))
    : options
  opts.forEach((o, i) => rankOf.set(o.value, i))
  rest.sort((a, b) => {
    const ra = rankOf.get(String(a)), rb = rankOf.get(String(b))
    if (ra !== undefined || rb !== undefined) return (ra ?? Infinity) - (rb ?? Infinity) || valueText(a).localeCompare(valueText(b))
    if (type === 'checkbox') return Number(b === true || b === 'true') - Number(a === true || a === 'true')
    if (typeof a === 'number' && typeof b === 'number') return a - b
    return valueText(a).localeCompare(valueText(b), 'fr', { numeric: true, sensitivity: 'base' })
  })
  return [...rest, ...empty]
}
