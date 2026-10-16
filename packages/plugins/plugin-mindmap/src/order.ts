// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Cles de tri fractionnaires : l'ordre des freres d'une carte mentale.
//
// Chaque noeud porte une cle (une chaine). Les freres se trient par cle,
// puis par id pour departager deux cles egales (deux insertions concurrentes
// au meme endroit). Inserer entre deux freres, c'est fabriquer une cle
// strictement entre les leurs : les autres freres ne bougent pas, donc deux
// membres qui reordonnent des freres differents ne s'ecrasent pas.
//
// Alphabet : 0-9 A-Z a-z, dans l'ordre des codes ASCII (la comparaison de
// chaines suffit). Une cle ne finit jamais par '0' : il reste toujours de la
// place avant elle.

const DIGITS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
const BASE = DIGITS.length

function digitValue(c: string): number {
  const v = DIGITS.indexOf(c)
  if (v < 0) throw new Error(`cle de tri invalide : ${c}`)
  return v
}

/** Une cle strictement entre a et b (a < b). '' = debut, null = fin. */
function midpoint(a: string, b: string | null): string {
  if (b !== null) {
    // Prefixe commun (a etant complete par des '0').
    let n = 0
    while (n < b.length && (a[n] ?? '0') === b[n]) n++
    if (n > 0) return b.slice(0, n) + midpoint(a.slice(n), b.slice(n))
  }
  const da = a ? digitValue(a[0]) : 0
  const db = b !== null ? digitValue(b[0]) : BASE
  if (db - da > 1) return DIGITS[Math.floor((da + db) / 2)]
  // Chiffres voisins : le premier chiffre de b seul suffit s'il est plus
  // court que b ; sinon on descend d'un rang apres le chiffre de a.
  if (b !== null && b.length > 1) return b[0]
  return DIGITS[da] + midpoint(a.slice(1), null)
}

/**
 * Cle entre `before` et `after` (null = pas de voisin de ce cote).
 * Exige before < after quand les deux sont donnes.
 */
export function keyBetween(before: string | null, after: string | null): string {
  if (before !== null && after !== null && before >= after) {
    throw new Error(`cles de tri dans le desordre : ${before} >= ${after}`)
  }
  return midpoint(before ?? '', after)
}

/** Compare deux freres : par cle, puis par id. */
export function compareSiblings(a: { order: string; id: string }, b: { order: string; id: string }): number {
  if (a.order !== b.order) return a.order < b.order ? -1 : 1
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

/**
 * Nouvelles cles pour qu'une suite de freres soit dans l'ordre voulu, en
 * changeant le moins de cles possible. `keys[i]` est la cle actuelle du
 * i-eme frere voulu, ou null s'il n'en a pas (noeud neuf, ou qui vient d'un
 * autre parent). Rend les cles a ecrire, par position.
 */
export function reorderKeys(keys: Array<string | null>): Map<number, string> {
  // Plus longue sous-suite strictement croissante des cles existantes : ces
  // freres gardent leur cle.
  const idx: number[] = []
  keys.forEach((k, i) => { if (k !== null) idx.push(i) })
  const tails: number[] = []
  const prev = new Map<number, number>()
  for (const i of idx) {
    const k = keys[i]!
    let lo = 0
    let hi = tails.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (keys[tails[mid]]! < k) lo = mid + 1
      else hi = mid
    }
    if (lo > 0) prev.set(i, tails[lo - 1])
    tails[lo] = i
  }
  const kept = new Set<number>()
  let cur: number | undefined = tails[tails.length - 1]
  while (cur !== undefined) { kept.add(cur); cur = prev.get(cur) }

  const out = new Map<number, string>()
  let before: string | null = null
  for (let i = 0; i < keys.length; i++) {
    if (kept.has(i)) { before = keys[i]; continue }
    let after: string | null = null
    for (let j = i + 1; j < keys.length; j++) {
      if (kept.has(j)) { after = keys[j]; break }
    }
    const k = keyBetween(before, after)
    out.set(i, k)
    before = k
  }
  return out
}
