// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Une ANCRE : un endroit precis d'une note (un curseur, ou un passage), que
// l'editeur donne a une IA et qu'elle rend pour ecrire au bon endroit.
//
//   { docId, start, end, quote, prefix, suffix }
//
//  - start, end : une position relative Yjs (Y.encodeRelativePosition, puis
//    base64) sur le Y.Text du contenu de la note, celui que l'editeur lie.
//    Curseur seul : end = start ;
//  - quote : le texte entre start et end (« » pour un curseur) ;
//  - prefix, suffix : jusqu'a 32 caracteres juste avant et juste apres.
//
// Resolution : l'hote, qui tient le Y.Doc, resout start et end. Si cela
// echoue, ou si le texte entre les deux n'est plus `quote`, on cherche
// `quote` dans la note ; prefix et suffix choisissent la bonne occurrence.
// Sinon : « ancre perdue ».
//
// Ici : le type, et la resolution de secours, pure (sans Yjs).
import { HostError } from './host'

export interface NoteAnchor {
  docId: string
  /** Position relative Yjs du debut, en base64. */
  start: string
  /** Position relative Yjs de la fin, en base64 (= start pour un curseur). */
  end: string
  /** Le texte entre les deux (« » pour un curseur). */
  quote: string
  /** Jusqu'a 32 caracteres juste avant. */
  prefix: string
  /** Jusqu'a 32 caracteres juste apres. */
  suffix: string
}

/** Longueur du contexte garde de chaque cote. */
export const ANCHOR_CONTEXT = 32
export const ANCHOR_LOST = 'ancre perdue'

/** Un contexte plus court ne designe rien a lui seul. */
const MIN_SIDE = 4
const MAX_QUOTE = 20_000

export interface TextRange {
  from: number
  to: number
}

/** L'ancre de [from, to) : `start` et `end` viennent de l'hote (positions relatives). */
export function anchorOf(docId: string, content: string, from: number, to: number, start: string, end: string): NoteAnchor {
  const a = Math.max(0, Math.min(from, to, content.length))
  const b = Math.min(content.length, Math.max(from, to))
  return {
    docId, start, end,
    quote: content.slice(a, b),
    prefix: content.slice(Math.max(0, a - ANCHOR_CONTEXT), a),
    suffix: content.slice(b, b + ANCHOR_CONTEXT),
  }
}

/** Lit une ancre recue d'une IA (objet, ou son JSON). Leve si elle est mal formee. */
export function parseAnchor(value: unknown): NoteAnchor {
  let v = value
  if (typeof v === 'string') {
    try { v = JSON.parse(v) } catch { throw new HostError('at : ancre illisible (JSON attendu).') }
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new HostError('at : ancre attendue { docId, start, end, quote, prefix, suffix }.')
  const o = v as Record<string, unknown>
  const s = (k: string, max: number): string => {
    const x = o[k]
    if (x === undefined || x === null) return ''
    if (typeof x !== 'string' || x.length > max) throw new HostError(`at.${k} invalide.`)
    return x
  }
  const docId = s('docId', 200)
  if (!docId) throw new HostError('at.docId manquant.')
  const start = s('start', 2000)
  return { docId, start, end: s('end', 2000) || start, quote: s('quote', MAX_QUOTE), prefix: s('prefix', 400), suffix: s('suffix', 400) }
}

function commonSuffix(a: string, b: string): number {
  let n = 0
  while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n++
  return n
}

function commonPrefix(a: string, b: string): number {
  let n = 0
  while (n < a.length && n < b.length && a[n] === b[n]) n++
  return n
}

function occurrences(content: string, find: string, max = 5000): number[] {
  const out: number[] = []
  for (let at = content.indexOf(find); at >= 0 && out.length < max; at = content.indexOf(find, at + 1)) out.push(at)
  return out
}

/**
 * Resolution de secours : cherche `quote` dans la note. Plusieurs occurrences :
 * celle dont le voisinage ressemble le plus a prefix et suffix ; a egalite,
 * rien (on n'ecrit pas au hasard). Curseur (quote vide) : la ou prefix et
 * suffix se suivent, sinon la ou l'un des deux est seul dans la note.
 */
export function locateAnchor(content: string, a: Pick<NoteAnchor, 'quote' | 'prefix' | 'suffix'>): TextRange | null {
  if (a.quote) {
    const hits = occurrences(content, a.quote)
    if (!hits.length) return null
    if (hits.length === 1) return { from: hits[0]!, to: hits[0]! + a.quote.length }
    let best = -1
    let bestScore = -1
    let tie = false
    for (const at of hits) {
      const score = commonSuffix(content.slice(Math.max(0, at - a.prefix.length), at), a.prefix)
        + commonPrefix(content.slice(at + a.quote.length, at + a.quote.length + a.suffix.length), a.suffix)
      if (score > bestScore) { best = at; bestScore = score; tie = false } else if (score === bestScore) tie = true
    }
    return tie || bestScore <= 0 ? null : { from: best, to: best + a.quote.length }
  }
  // Un curseur.
  if (!a.prefix && !a.suffix) return content === '' ? { from: 0, to: 0 } : null
  const both = occurrences(content, a.prefix + a.suffix, 2)
  if (both.length === 1) {
    // Sans prefixe, le curseur etait au debut de la note ; sans suffixe, a la fin.
    const at = both[0]! + a.prefix.length
    if ((a.prefix || both[0] === 0) && (a.suffix || at === content.length)) return { from: at, to: at }
  }
  if (both.length > 1) return null
  if (a.prefix.length >= MIN_SIDE) {
    const p = occurrences(content, a.prefix, 2)
    if (p.length === 1) return { from: p[0]! + a.prefix.length, to: p[0]! + a.prefix.length }
  }
  if (a.suffix.length >= MIN_SIDE) {
    const s = occurrences(content, a.suffix, 2)
    if (s.length === 1) return { from: s[0]!, to: s[0]! }
  }
  return null
}

/**
 * Ou est l'ancre dans le texte d'aujourd'hui. `relative` : ce que l'hote a
 * resolu de start et end (null : echec, ou hote sans Y.Doc). Null : ancre perdue.
 */
export function resolveAnchor(content: string, a: NoteAnchor, relative: TextRange | null): TextRange | null {
  if (relative && relative.from >= 0 && relative.from <= relative.to && relative.to <= content.length
    && content.slice(relative.from, relative.to) === a.quote) {
    return { from: relative.from, to: relative.to }
  }
  return locateAnchor(content, a)
}
