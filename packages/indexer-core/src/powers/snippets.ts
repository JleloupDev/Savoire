// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Texte cherche et extraits de la recherche plein texte. Fonctions pures.
//
// Le texte tape est NETTOYE : il ne devient jamais de la syntaxe FTS5. On
// n'en garde que des mots (lettres et chiffres, replies), et des suites
// exactes entre guillemets ; on ecrit soi-meme la requete FTS5 avec.
//
// Les extraits sont calcules en JS sur le texte brut des sections : les
// positions de surlignage sont celles du texte rendu (unites JS).
import type { SearchHighlight, SearchSnippet } from '@savoire/plugin-api'
import { IndexError } from '../errors'
import type { Section } from '../extract/markdown'
import { tokenize, words } from '../text'

export const MAX_SEARCH_WORDS = 32

export interface SearchTerms {
  /** Mots replies : chacun vaut aussi comme debut de mot. */
  terms: string[]
  /** Suites exactes (entre guillemets), mot a mot. */
  phrases: string[][]
}

/** Le texte tape -> mots et suites exactes. */
export function parseSearchText(text: string): SearchTerms {
  const phrases: string[][] = []
  const rest = text.replace(/"([^"]*)"/g, (_m, inner: string) => {
    const w = words(inner)
    if (w.length) phrases.push(w)
    return ' '
  })
  const terms = [...new Set(words(rest))]
  const count = terms.length + phrases.reduce((n, p) => n + p.length, 0)
  if (count > MAX_SEARCH_WORDS) throw new IndexError('too_complex', `Recherche trop longue (${MAX_SEARCH_WORDS} mots au plus).`)
  return { terms, phrases }
}

export function isEmptySearch(t: SearchTerms): boolean {
  return t.terms.length === 0 && t.phrases.length === 0
}

/**
 * Requete FTS5 ecrite par nous : chaque mot entre guillemets (il ne contient
 * que des lettres et des chiffres) suivi de * (debut de mot), chaque suite
 * exacte entre guillemets ; tout est requis (AND). `columns` : colonnes
 * cherchees (toutes si absent).
 */
export function ftsMatch(t: SearchTerms, columns?: readonly string[]): string {
  const scope = columns ? `{${columns.join(' ')}} : ` : ''
  return [
    ...t.terms.map(w => `${scope}"${w}"*`),
    ...t.phrases.map(p => `${scope}"${p.join(' ')}"`),
  ].join(' AND ')
}

interface Match extends SearchHighlight {
  /** Quel mot ou quelle suite (index dans terms, puis phrases). */
  term: number
}

/** Les mots trouves dans un texte, dans l'ordre, sans chevauchement. */
export function findMatches(text: string, t: SearchTerms): Match[] {
  const tokens = tokenize(text)
  const out: Match[] = []
  let busyUntil = -1
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i]
    if (tok.start < busyUntil) continue
    let found: Match | null = null
    for (let j = 0; j < t.phrases.length && !found; j++) {
      const p = t.phrases[j]
      if (i + p.length > tokens.length) continue
      if (p.every((w, k) => tokens[i + k].folded === w)) {
        found = { start: tok.start, end: tokens[i + p.length - 1].end, term: t.terms.length + j }
      }
    }
    for (let j = 0; j < t.terms.length && !found; j++) {
      if (tok.folded.startsWith(t.terms[j])) found = { start: tok.start, end: tok.end, term: j }
    }
    if (found) {
      out.push(found)
      busyUntil = found.end
    }
  }
  return out
}

export function highlightsOf(text: string, t: SearchTerms): SearchHighlight[] {
  return findMatches(text, t).map(({ start, end }) => ({ start, end }))
}

const BEFORE = 60
const WIDTH = 180
const MAX_ANCHORS = 200

interface Candidate {
  section: number
  start: number
  end: number
  score: number
  matches: Match[]
}

/** Recule / avance une borne jusqu'a un espace, pour ne pas couper un mot. */
function snapStart(text: string, a: number): number {
  if (a <= 0) return 0
  const space = text.slice(a, a + 20).search(/\s/)
  return space < 0 ? a : a + space + 1
}

function snapEnd(text: string, b: number): number {
  if (b >= text.length) return text.length
  const head = text.slice(Math.max(0, b - 20), b)
  const space = head.search(/\s\S*$/)
  return space < 0 ? b : b - head.length + space
}

/** Jusqu'a `max` extraits autour des mots trouves, dans l'ordre du texte. */
export function buildSnippets(sections: readonly Section[], t: SearchTerms, max = 3): SearchSnippet[] {
  const candidates: Candidate[] = []
  sections.forEach((s, si) => {
    const matches = findMatches(s.text, t)
    for (const m of matches.slice(0, MAX_ANCHORS)) {
      const start = snapStart(s.text, m.start - BEFORE)
      const end = Math.max(snapEnd(s.text, start + WIDTH), m.end)
      const inside = matches.filter(x => x.start >= start && x.end <= end)
      const distinct = new Set(inside.map(x => x.term)).size
      candidates.push({ section: si, start, end, score: distinct * 100 + inside.length, matches: inside })
    }
  })
  const chosen: Candidate[] = []
  while (chosen.length < max) {
    let best: Candidate | null = null
    for (const c of candidates) {
      if (chosen.some(o => o.section === c.section && c.start < o.end && o.start < c.end)) continue
      if (!best || c.score > best.score || (c.score === best.score && (c.section < best.section || (c.section === best.section && c.start < best.start)))) best = c
    }
    if (!best) break
    chosen.push(best)
  }
  chosen.sort((a, b) => a.section - b.section || a.start - b.start)
  return chosen.map(c => {
    const s = sections[c.section]
    const lead = c.start > 0 ? '…' : ''
    const text = lead + s.text.slice(c.start, c.end).replace(/\n/g, ' ') + (c.end < s.text.length ? '…' : '')
    const shift = lead.length - c.start
    const snippet: SearchSnippet = {
      text,
      highlights: c.matches.map(m => ({ start: m.start + shift, end: m.end + shift })),
    }
    if (s.heading) snippet.heading = s.heading
    return snippet
  })
}
