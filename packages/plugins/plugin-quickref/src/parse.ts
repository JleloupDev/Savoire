// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Lecture d'une reference ecrite a la main, comme dans une citation :
//
//   Gen 1           un chapitre (nom ou alias, accents, points et espaces ignores) ;
//   Gen 1:3         un verset ;  Gen 1:3-5  une suite ;  Heb 12:3,7,8  une liste ;
//   Jean 3:16, 4:1  un autre chapitre du meme livre ;
//   Ps. 139:17 ; Marc 8:33 ; 17:4   plusieurs groupes (un nombre seul : meme livre).
//
// Le livre peut etre abrege sans etre un alias declare : « 1 Chro 1 » trouve
// « 1 Chroniques » (l'alias le plus court qui commence ainsi).
import { foldAccents, normalize, type ReferenceIndex, type ReferenceInfo } from './references'

export interface VerseTarget {
  info: ReferenceInfo
  verse: number
}

export interface ParsedReference {
  /** Texte de la reference, tel que saisi (« Gen 1:3-5 »). */
  label: string
  /** Un texte par verset (prefixe du numero s'il y en a plusieurs). */
  preview: string[]
  targets: VerseTarget[]
}

export interface ResolvedChapter {
  info: ReferenceInfo
  book: string
  chapter: number
}

export class ReferenceParser {
  constructor(private readonly index: ReferenceIndex, private readonly separator: string) {}

  /** Le livre dont un alias commence par `prefix` (deja normalise) : exact, sinon le plus court. */
  resolveBook(prefix: string): string | null {
    if (!prefix) return null
    const exact = this.index.bookAliases.get(prefix)
    if (exact) return exact
    let best: string | null = null
    let bestLength = Infinity
    for (const [key, book] of this.index.bookAliases) {
      if (key.length < bestLength && key.startsWith(prefix)) { best = book; bestLength = key.length }
    }
    return best
  }

  /** « Gen 1 », « Gen1 », « 1 Chro 1 », « Ps. 23 » -> le chapitre. */
  resolveChapter(raw: string): ResolvedChapter | null {
    const query = raw.trim()
    if (!query) return null
    let name = this.index.chapterAliases.get(normalize(query)) ?? null
    if (!name) {
      const m = /^(.*?)(\d+)$/.exec(query)
      if (!m) return null
      const book = this.resolveBook(normalize(m[1]))
      if (!book) return null
      name = `${book} ${m[2]}`
    }
    const info = this.index.byName.get(name)
    if (!info) return null
    const split = /^(.*?)\s*(\d+)$/.exec(name)
    if (!split) return null
    return { info, book: split[1], chapter: parseInt(split[2], 10) }
  }

  /** Un groupe d'une citation : un nombre seul est un chapitre du livre precedent. */
  private resolveGroupChapter(raw: string, previousBook: string | null): ResolvedChapter | null {
    const resolved = this.resolveChapter(raw)
    if (resolved || !previousBook) return resolved
    const t = raw.trim()
    if (!/^\d+$/.test(t)) return null
    const chapter = parseInt(t, 10)
    const info = this.index.byName.get(`${previousBook} ${chapter}`)
    return info ? { info, book: previousBook, chapter } : null
  }

  /** Les versets d'un chapitre : « 3 », « 3-5 », « 3,7,8 », « 3, 13:8 ». */
  parseVerses(resolved: ResolvedChapter, chapterPart: string, versePart: string): ParsedReference | null {
    const segments = versePart.split(',').map(s => s.trim()).filter(Boolean)
    if (!segments.length) return null
    let info = resolved.info
    let chapter = resolved.chapter
    const ranges: { info: ReferenceInfo; chapter: number; from: number; to: number }[] = []
    for (const seg of segments) {
      const m = /^(?:(\d+):)?(\d+)(-(\d*))?$/.exec(seg)
      if (!m) return null
      if (m[1]) {
        chapter = parseInt(m[1], 10)
        const other = this.index.byName.get(`${resolved.book} ${chapter}`)
        if (!other) return null
        info = other
      }
      const from = parseInt(m[2], 10)
      if (from < 1 || (info.lastVerse > 0 && from > info.lastVerse)) return null
      let to = from
      if (m[4]) {
        to = Math.max(from, parseInt(m[4], 10))
        if (info.lastVerse > 0) to = Math.min(to, info.lastVerse)
      }
      ranges.push({ info, chapter, from, to })
    }
    const severalChapters = new Set(ranges.map(r => r.chapter)).size > 1
    const count = ranges.reduce((n, r) => n + r.to - r.from + 1, 0)
    const targets: VerseTarget[] = []
    const preview: string[] = []
    for (const r of ranges) {
      for (let v = r.from; v <= r.to; v++) {
        targets.push({ info: r.info, verse: v })
        const text = r.info.verses.get(v)
        if (!text) continue
        preview.push(severalChapters ? `${r.chapter}:${v}. ${text}` : count > 1 ? `${v}. ${text}` : text)
      }
    }
    if (!targets.length) return null
    return { label: `${chapterPart.trim()}${this.separator}${versePart.trim()}`, preview, targets }
  }

  /** Une reference d'un seul groupe : « Gen 1 » + « 3-5 ». */
  parseSingle(chapterPart: string, versePart: string): ParsedReference | null {
    const resolved = this.resolveChapter(chapterPart)
    return resolved ? this.parseVerses(resolved, chapterPart, versePart) : null
  }

  /** Une citation complete, groupes separes par « ; ». null : pas une reference. */
  parse(fullText: string): ParsedReference | null {
    const groups = fullText.split(';').map(s => s.trim()).filter(Boolean)
    if (!groups.length) return null
    const targets: VerseTarget[] = []
    const preview: string[] = []
    const labels: string[] = []
    let book: string | null = null
    for (const group of groups) {
      const at = group.indexOf(this.separator)
      if (at <= 0) return null
      const chapterPart = group.slice(0, at)
      const resolved = this.resolveGroupChapter(chapterPart, book)
      if (!resolved) return null
      book = resolved.book
      const parsed = this.parseVerses(resolved, chapterPart, group.slice(at + 1))
      if (!parsed) return null
      targets.push(...parsed.targets)
      preview.push(...(groups.length > 1 ? parsed.preview.map(l => `${parsed.label} — ${l}`) : parsed.preview))
      labels.push(parsed.label)
    }
    return { label: labels.join(' ; '), preview, targets }
  }

  /** Chapitres dont un nom ou alias contient `query` (normalise), par ordre alphabetique. */
  chapters(query: string): ReferenceInfo[] {
    const names = new Set<string>()
    for (const [key, name] of this.index.chapterAliases) if (key.includes(query)) names.add(name)
    return [...names]
      .map(n => this.index.byName.get(n))
      .filter((i): i is ReferenceInfo => !!i)
      .sort((a, b) => a.name.localeCompare(b.name, 'fr', { numeric: true }))
  }

  /** Versets qui contiennent `term` (accents et casse ignores), dans un chapitre ou partout. */
  search(term: string, limit: number, only?: ReferenceInfo): VerseTarget[] {
    const wanted = foldAccents(term.trim())
    if (!wanted) return []
    const out: VerseTarget[] = []
    const scan = (info: ReferenceInfo, texts: Map<number, string>): boolean => {
      for (const v of [...texts.keys()].sort((a, b) => a - b)) {
        if (!texts.get(v)!.includes(wanted)) continue
        out.push({ info, verse: v })
        if (out.length >= limit) return true
      }
      return false
    }
    if (only) {
      const texts = this.index.searchText.get(only)
      if (texts) scan(only, texts)
      return out
    }
    for (const [info, texts] of this.index.searchText) if (scan(info, texts)) break
    return out
  }
}
