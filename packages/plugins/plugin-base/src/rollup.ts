// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Definition d'un rollup (colonne calculee sur les lignes liees par une
// relation) et ses calculs. Le suivi des lignes liees : relations.ts.
import type { PropertyValue } from '@savoire/plugin-api'
import { valueText } from './cells'
import { computeTotal, isTotalKind, type TotalKind } from './totals'

export type RollupCalc = 'show' | 'count' | 'percentChecked' | TotalKind

export interface RollupDef {
  /** Propriete relation de la ligne. */
  relation: string
  /** Propriete des lignes liees ('@title' : leur nom). */
  prop: string
  calc: RollupCalc
}

export const ROLLUP_CALCS: { calc: RollupCalc; label: string }[] = [
  { calc: 'show', label: 'Afficher les valeurs' },
  { calc: 'count', label: 'Nombre de lignes liées' },
  { calc: 'sum', label: 'Somme' },
  { calc: 'mean', label: 'Moyenne' },
  { calc: 'median', label: 'Médiane' },
  { calc: 'min', label: 'Minimum' },
  { calc: 'max', label: 'Maximum' },
  { calc: 'filled', label: 'Remplies' },
  { calc: 'empty', label: 'Vides' },
  { calc: 'unique', label: 'Valeurs distinctes' },
  { calc: 'checked', label: 'Cochées' },
  { calc: 'unchecked', label: 'Non cochées' },
  { calc: 'percentChecked', label: 'Pourcentage cochées' },
]

export function readRollup(raw: unknown): RollupDef | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const o = raw as Record<string, unknown>
  if (typeof o.relation !== 'string' || !o.relation || typeof o.prop !== 'string' || !o.prop) return undefined
  const calc = typeof o.calc === 'string' && (o.calc === 'show' || o.calc === 'count' || o.calc === 'percentChecked' || isTotalKind(o.calc)) ? o.calc as RollupCalc : 'show'
  return { relation: o.relation, prop: o.prop, calc }
}

/** Un calcul sur des valeurs liees. */
export function rollupValue(calc: RollupCalc, values: (PropertyValue | undefined)[], count: number): PropertyValue {
  switch (calc) {
    case 'show': {
      const out: string[] = []
      for (const v of values) {
        if (v === null || v === undefined || v === '') continue
        for (const x of Array.isArray(v) ? v : [v]) out.push(valueText(x as PropertyValue))
      }
      return out
    }
    case 'count': return count
    case 'percentChecked': {
      if (!values.length) return null
      const checked = values.filter(v => v === true || v === 'true').length
      return Math.round(checked / values.length * 1000) / 10
    }
    default: return computeTotal(calc, values)
  }
}
