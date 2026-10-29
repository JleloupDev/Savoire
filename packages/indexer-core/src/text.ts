// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Texte : repli (casse, accents), decoupage en mots, comparaison de valeurs.
// Ces regles sont CELLES du moteur de reference (InMemoryQueryEngine de
// plugin-runtime) : les tests verifient qu'elles donnent le meme resultat.
// On les calcule en JS, jamais en SQL : SQLite n'a ni le meme repli ni le
// meme decoupage.
import type { PropertyValue } from '@savoire/plugin-api'

/** Minuscules, sans accents : les comparaisons de texte n'en tiennent pas compte. */
export function foldText(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
}

/** Les mots d'un texte, replies (lettres et chiffres). */
export function words(s: string): string[] {
  return foldText(s).split(/[^\p{L}\p{N}]+/u).filter(Boolean)
}

/** Un mot du texte d'origine, avec sa place. */
export interface TextToken {
  start: number
  end: number
  /** Le mot replie. */
  folded: string
}

/** Les mots d'un texte avec leurs positions dans le texte d'origine. */
export function tokenize(s: string): TextToken[] {
  const out: TextToken[] = []
  for (const m of s.matchAll(/[\p{L}\p{N}\p{M}]+/gu)) {
    // Un mot peut se replier en plusieurs (marque hors des accents latins) :
    // on garde le premier morceau pour la comparaison.
    const folded = words(m[0])[0]
    if (folded) out.push({ start: m.index!, end: m.index! + m[0].length, folded })
  }
  return out
}

/** Vide : absent, null, '' ou liste vide. */
export function isEmptyValue(v: PropertyValue | undefined): boolean {
  return v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0)
}

/** Comparaison de deux valeurs non vides : nombres, booleens, sinon texte replie. */
export function compareValues(a: PropertyValue, b: PropertyValue): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b
  if (typeof a === 'boolean' && typeof b === 'boolean') return Number(a) - Number(b)
  const fa = foldText(String(a))
  const fb = foldText(String(b))
  return fa < fb ? -1 : fa > fb ? 1 : 0
}

/** Ordre de deux chaines par unites de code, comme `<` en JS. */
export function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/** Empreinte courte et stable (FNV-1a 64 bits, en base 36). */
export function hashText(s: string): string {
  let h = 0xcbf29ce484222325n
  for (let i = 0; i < s.length; i++) {
    h ^= BigInt(s.charCodeAt(i))
    h = (h * 0x100000001b3n) & 0xffffffffffffffffn
  }
  return h.toString(36)
}

/** Curseur opaque : du JSON en base 64 (UTF-8). */
export function encodeOpaque(payload: unknown): string {
  return btoa(unescape(encodeURIComponent(JSON.stringify(payload))))
}

/** Relit un curseur. Leve une erreur s'il est illisible. */
export function decodeOpaque(cursor: string): unknown {
  return JSON.parse(decodeURIComponent(escape(atob(cursor))))
}
