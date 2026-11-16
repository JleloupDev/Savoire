// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Les deux commandes, en fonctions pures sur le texte : elles rendent les
// insertions a faire, l'editeur les applique (changements minimaux, qui se
// fusionnent avec les frappes des autres membres).
//  - la reference selectionnee (« Heb 12:3,7,8 ») : ses versets sous la ligne ;
//  - tout le document : les references entre parentheses de chaque ligne
//    (« (Ps 119:105 ; Jean 17:17) »), leurs versets sous la ligne. Une ligne
//    deja suivie de ses versets n'est pas refaite.
import type { ReferenceParser } from './parse'
import { embedOf, type LinkTarget } from './suggest'

export interface Insertion {
  at: number
  insert: string
}

/** Un groupe entre parentheses, sans parentheses imbriquees : « (Mat 6:22) ». */
const PARENTHESES_RE = /\(([^()]+)\)/g

export type SelectionResult =
  | { ok: true; insertion: Insertion; count: number }
  | { ok: false; reason: 'empty' | 'unknown'; text: string }

/** Les versets de la reference selectionnee, a la fin de la ligne ou finit la selection. */
export function referenceBelowSelection(
  text: string, from: number, to: number, parser: ReferenceParser, linkTarget: LinkTarget,
): SelectionResult {
  const selected = text.slice(from, to).trim()
  if (!selected) return { ok: false, reason: 'empty', text: selected }
  const parsed = parser.parse(selected)
  if (!parsed) return { ok: false, reason: 'unknown', text: selected }
  const lineEnd = text.indexOf('\n', to)
  const at = lineEnd < 0 ? text.length : lineEnd
  const embeds = parsed.targets.map(t => embedOf(t, linkTarget))
  return { ok: true, insertion: { at, insert: `\n${embeds.join('\n')}` }, count: embeds.length }
}

/** Les integrations des references entre parentheses d'une ligne. */
export function embedsInLine(line: string, parser: ReferenceParser, linkTarget: LinkTarget): string[] {
  const embeds: string[] = []
  for (const m of line.matchAll(PARENTHESES_RE)) {
    // Une parenthese qui n'est pas une reference (page, heure...) est ignoree.
    const parsed = parser.parse(m[1])
    if (parsed) embeds.push(...parsed.targets.map(t => embedOf(t, linkTarget)))
  }
  return embeds
}

export interface DocumentResult {
  insertions: Insertion[]
  verses: number
  lines: number
}

export function referencesInDocument(text: string, parser: ReferenceParser, linkTarget: LinkTarget): DocumentResult {
  const lines = text.split('\n')
  const insertions: Insertion[] = []
  let verses = 0
  let offset = 0
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const end = offset + line.length
    offset = end + 1
    const embeds = embedsInLine(line, parser, linkTarget)
    if (!embeds.length) continue
    // Deja fait (commande relancee) : les lignes suivantes sont ces versets.
    if (embeds.every((e, k) => lines[i + 1 + k]?.trim() === e)) continue
    insertions.push({ at: end, insert: `\n${embeds.join('\n')}` })
    verses += embeds.length
  }
  return { insertions, verses, lines: insertions.length }
}
