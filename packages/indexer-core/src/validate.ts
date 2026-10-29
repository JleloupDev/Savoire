// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Verification des parametres des methodes : ils arrivent du reseau (JSON),
// rien n'est suppose. Toute erreur est un IndexError('invalid_query').
import { invalid } from './errors'

export type Params = Record<string, unknown>

export function asObject(v: unknown, what = 'parametres'): Params {
  if (v === undefined || v === null) return {}
  if (typeof v !== 'object' || Array.isArray(v)) throw invalid(`${what} : objet attendu.`)
  return v as Params
}

export function optString(p: Params, key: string, max = 4096): string | undefined {
  const v = p[key]
  if (v === undefined || v === null) return undefined
  if (typeof v !== 'string') throw invalid(`${key} : texte attendu.`)
  if (v.length > max) throw invalid(`${key} : ${max} caracteres au plus.`)
  return v
}

export function reqString(p: Params, key: string, max = 4096): string {
  const v = optString(p, key, max)
  if (v === undefined || v === '') throw invalid(`${key} : obligatoire.`)
  return v
}

export function optInt(p: Params, key: string, min: number, max: number, dflt: number): number {
  const v = p[key]
  if (v === undefined || v === null) return dflt
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) {
    throw invalid(`${key} doit etre un entier entre ${min} et ${max}.`)
  }
  return v
}

export function optStringList(p: Params, key: string, maxItems = 100, maxLen = 256): string[] | undefined {
  const v = p[key]
  if (v === undefined || v === null) return undefined
  if (!Array.isArray(v) || v.length > maxItems || v.some(x => typeof x !== 'string' || x.length > maxLen)) {
    throw invalid(`${key} : liste de textes attendue (${maxItems} au plus).`)
  }
  return v as string[]
}
