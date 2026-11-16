// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Lire un chapitre sur wol.jw.org (Bibliotheque en ligne Watchtower).
//
// Adresse : https://wol.jw.org/<langue>/wol/b/<rsconf>/<lib>/<publication>/<livre>/<chapitre>
// Chaque morceau de verset est un <span id="v<livre>-<chapitre>-<verset>-<morceau>" class="v"> ;
// un verset de poesie a un morceau par ligne. Le verset 0 est le titre d'un
// psaume. Dans le morceau, on retire le numero du verset (lien « vl »/« cl »), les
// renvois (« + ») et les appels de note (« * ») ; le reste est le texte.
//
// Pas de DOM : le meme code tourne dans l'application et dans un script Node.

export interface ParsedVerse {
  number: number
  /** Une ligne par morceau (poesie), au moins une. */
  lines: string[]
}

export interface WolEdition {
  /** « fr » */
  language: string
  /** « r30 » */
  rsconf: string
  /** « lp-f » */
  lib: string
  /** « nwt » */
  publication: string
}

export function wolChapterUrl(e: WolEdition, book: number, chapter: number): string {
  return `https://wol.jw.org/${e.language}/wol/b/${e.rsconf}/${e.lib}/${e.publication}/${book}/${chapter}`
}

const SPAN_OPEN_RE = /<span\b[^>]*>/gi

/** Fin du <span> ouvert a `from` (balises <span> imbriquees comptees). */
function spanEnd(html: string, from: number): number {
  const re = /<span\b[^>]*>|<\/span\s*>/gi
  re.lastIndex = from
  let depth = 0
  for (let m = re.exec(html); m; m = re.exec(html)) {
    if (m[0][1] === '/') { if (--depth === 0) return m.index } else depth++
  }
  return html.length
}

const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00A0' }

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, code: string) => {
    if (code[0] === '#') {
      const n = code[1] === 'x' || code[1] === 'X' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10)
      return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : all
    }
    return NAMED[code.toLowerCase()] ?? all
  })
}

/** Le texte d'un morceau de verset. */
export function pieceText(inner: string): string {
  const text = inner
    // Lien du numero de verset (« 3 », ou « <strong>1</strong> » au debut d'un
    // chapitre) : classe « vl vx vp », « vl vp » ou « cl vx vp » selon le verset.
    .replace(/<a\b[^>]*class="[^"]*\b(?:vl|cl|vx|vp)\b[^"]*"[^>]*>[\s\S]*?<\/a>/gi, '')
    // Renvois (+) et appels de note (*).
    .replace(/<a\b[^>]*class="[^"]*\b(?:b|fn)\b[^"]*"[^>]*>[\s\S]*?<\/a>/gi, '')
    .replace(/<[^>]+>/g, '')
  return decodeEntities(text)
    // Espaces sans chasse (« sont-​ils ») : genants pour la recherche.
    .replace(/[​‌‍﻿]/g, '')
    // Espaces ordinaires reduites ; les insecables (« dit : ») restent.
    .replace(/[ \t\r\n]+/g, ' ')
    .replace(/^[ \u00A0]+|[ \u00A0]+$/g, '')
}

/** Les versets d'un chapitre, dans l'ordre. Vide si la page n'en a pas. */
export function parseWolChapter(html: string, book: number, chapter: number): ParsedVerse[] {
  const verses = new Map<number, { piece: number; text: string }[]>()
  const idRe = /\bid="v(\d+)-(\d+)-(\d+)-(\d+)"/
  SPAN_OPEN_RE.lastIndex = 0
  for (let m = SPAN_OPEN_RE.exec(html); m; m = SPAN_OPEN_RE.exec(html)) {
    const id = idRe.exec(m[0])
    if (!id || !/\bclass="v"/.test(m[0])) continue
    if (Number(id[1]) !== book || Number(id[2]) !== chapter) continue
    const end = spanEnd(html, m.index)
    const text = pieceText(html.slice(m.index + m[0].length, end))
    SPAN_OPEN_RE.lastIndex = end
    if (!text) continue
    const number = Number(id[3])
    let pieces = verses.get(number)
    if (!pieces) verses.set(number, pieces = [])
    pieces.push({ piece: Number(id[4]), text })
  }
  return [...verses.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([number, pieces]) => ({ number, lines: pieces.sort((a, b) => a.piece - b.piece).map(p => p.text) }))
}
