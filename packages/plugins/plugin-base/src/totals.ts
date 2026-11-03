// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Totaux en bas des colonnes d'un tableau : un calcul par colonne, choisi
// dans la vue (somme, moyenne, min, max, nombre...). Calcule sur toutes les
// lignes de la vue, pas seulement celles affichees.
import type { PropertyValue } from '@savoire/plugin-api'
import { valueText } from './cells'

export type TotalKind = 'sum' | 'mean' | 'median' | 'min' | 'max' | 'filled' | 'empty' | 'checked' | 'unchecked' | 'unique'

export const TOTAL_KINDS: { kind: TotalKind; label: string; short: string }[] = [
  { kind: 'sum', label: 'Somme', short: 'Somme' },
  { kind: 'mean', label: 'Moyenne', short: 'Moy.' },
  { kind: 'median', label: 'Médiane', short: 'Méd.' },
  { kind: 'min', label: 'Minimum', short: 'Min' },
  { kind: 'max', label: 'Maximum', short: 'Max' },
  { kind: 'filled', label: 'Remplies', short: 'Remplies' },
  { kind: 'empty', label: 'Vides', short: 'Vides' },
  { kind: 'unique', label: 'Valeurs distinctes', short: 'Distinctes' },
  { kind: 'checked', label: 'Cochées', short: 'Cochées' },
  { kind: 'unchecked', label: 'Non cochées', short: 'Non cochées' },
]

export const isTotalKind = (k: unknown): k is TotalKind => TOTAL_KINDS.some(t => t.kind === k)

const isEmpty = (v: PropertyValue | undefined) => v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0)

/**
 * Un nombre ; null sinon. Comme le moteur de requetes et les formules : un
 * « 3 » ecrit en texte reste du texte (typer la propriete en nombre).
 */
function numberOf(v: PropertyValue | undefined): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

/** Le total d'une colonne ; null quand il n'a pas de sens (somme de textes). */
export function computeTotal(kind: TotalKind, values: (PropertyValue | undefined)[]): PropertyValue {
  switch (kind) {
    case 'filled': return values.filter(v => !isEmpty(v)).length
    case 'empty': return values.filter(v => isEmpty(v)).length
    case 'checked': return values.filter(v => v === true || v === 'true').length
    case 'unchecked': return values.filter(v => !(v === true || v === 'true')).length
    case 'unique': {
      const seen = new Set<string>()
      for (const v of values) {
        if (isEmpty(v)) continue
        for (const x of Array.isArray(v) ? v : [v]) seen.add(valueText(x as PropertyValue).toLowerCase())
      }
      return seen.size
    }
  }
  const present = values.filter(v => !isEmpty(v))
  const nums = present.map(numberOf).filter((n): n is number => n !== null)
  // Min et max sans nombre : les textes (dates ISO comprises), compares tels quels.
  if ((kind === 'min' || kind === 'max') && nums.length === 0) {
    const texts = present.filter((v): v is string => typeof v === 'string').sort()
    if (!texts.length) return null
    return kind === 'min' ? texts[0] : texts[texts.length - 1]
  }
  if (nums.length === 0) return kind === 'sum' ? 0 : null
  switch (kind) {
    case 'sum': return round(nums.reduce((a, b) => a + b, 0))
    case 'mean': return round(nums.reduce((a, b) => a + b, 0) / nums.length)
    case 'median': {
      const s = [...nums].sort((a, b) => a - b)
      const m = Math.floor(s.length / 2)
      return round(s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2)
    }
    case 'min': return Math.min(...nums)
    case 'max': return Math.max(...nums)
  }
}

/** Sans les restes des flottants (0.1 + 0.2). */
function round(n: number): number {
  return Math.round(n * 1e9) / 1e9
}

/** Texte du pied de colonne : « Somme 42 ». */
export function totalText(kind: TotalKind, value: PropertyValue): string {
  const short = TOTAL_KINDS.find(t => t.kind === kind)?.short ?? kind
  const v = typeof value === 'number' ? value.toLocaleString('fr-FR', { maximumFractionDigits: 2 }) : valueText(value)
  return `${short} ${v || '—'}`
}
