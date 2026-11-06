// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Les references du dossier (la Bible) : chapitres, livres, alias et versets,
// lus dans les notes. Un chapitre porte le tag `Bible/Chapter`, un livre le
// tag `Bible/Book` ; leurs alias sont dans le frontmatter (`aliases`).
// Un verset est un bloc dont la derniere ligne finit par « ^numero » :
//
//   *Au commencement, Dieu crea le ciel et la terre.*
//   *Genese 1 : 1*^1
//
// Son texte est la premiere ligne du bloc, sans les asterisques.
import { findFrontmatter, parseFrontmatter } from '@savoire/plugin-api'

export const CHAPTER_TAG = 'Bible/Chapter'
export const BOOK_TAG = 'Bible/Book'

export interface ReferenceInfo {
  /** Chemin de la note, avec son extension. */
  path: string
  /** Nom de la note sans extension : « Genese 1 ». */
  name: string
  /** Plus grand numero de verset (0 : pas de versets). */
  lastVerse: number
  verses: Map<number, string>
}

/** Dictionnaire des references, cherche par nom normalise. */
export interface ReferenceIndex {
  /** Par nom de note. */
  byName: Map<string, ReferenceInfo>
  /** Alias de chapitre normalise -> nom du chapitre (« gen1 » -> « Genese 1 »). */
  chapterAliases: Map<string, string>
  /** Alias de livre normalise -> nom du livre (« 1chr » -> « 1 Chroniques »). */
  bookAliases: Map<string, string>
  /** Texte normalise de chaque verset, pour la recherche (calcule une fois). */
  searchText: Map<ReferenceInfo, Map<number, string>>
}

export function emptyIndex(): ReferenceIndex {
  return { byName: new Map(), chapterAliases: new Map(), bookAliases: new Map(), searchText: new Map() }
}

/** Sans accents ni casse. */
export function foldAccents(input: string): string {
  return input.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
}

/** Cle de comparaison d'un nom : sans accents, casse, points ni espaces (« Ps. 23 » = « ps23 »). */
export function normalize(input: string): string {
  return foldAccents(input).replace(/[.\s]/g, '')
}

function listOf(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string')
  if (typeof value === 'string' && value.trim()) return [value.trim()]
  return []
}

function hasTag(tags: string[], tag: string): boolean {
  const wanted = tag.toLowerCase()
  return tags.some(t => t.replace(/^#/, '').toLowerCase() === wanted)
}

const VERSE_MARK_RE = /\^(\d+)\s*$/

/** Les versets d'un chapitre : numero -> texte. */
export function extractVerses(body: string): Map<number, string> {
  const verses = new Map<number, string>()
  for (const block of body.split(/\n[ \t]*\n/)) {
    const lines = block.split('\n').map(l => l.trim()).filter(Boolean)
    if (!lines.length) continue
    const mark = VERSE_MARK_RE.exec(lines[lines.length - 1])
    if (!mark) continue
    const number = parseInt(mark[1], 10)
    const text = lines[0].replace(VERSE_MARK_RE, '').replace(/^\*+|\*+$/g, '').trim()
    if (number > 0 && text) verses.set(number, text)
  }
  return verses
}

function noteNameOf(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1).replace(/\.md$/i, '')
}

/** Ajoute une note du dossier a l'index. */
export function addNote(index: ReferenceIndex, path: string, content: string): void {
  const text = content.replace(/\r\n?/g, '\n')
  const name = noteNameOf(path)
  const fm = parseFrontmatter(text)
  const tags = listOf(fm.tags)
  const aliases = listOf(fm.aliases)
  const isChapter = hasTag(tags, CHAPTER_TAG)
  const isBook = hasTag(tags, BOOK_TAG)

  index.chapterAliases.set(normalize(name), name)
  if (isChapter) for (const alias of aliases) index.chapterAliases.set(normalize(alias), name)
  if (isBook) {
    index.bookAliases.set(normalize(name), name)
    for (const alias of aliases) index.bookAliases.set(normalize(alias), name)
  }

  // Seuls les chapitres sont decoupes en versets ; un livre liste ses chapitres.
  const body = text.slice(findFrontmatter(text)?.end ?? 0)
  const verses = isChapter ? extractVerses(body) : new Map<number, string>()
  let lastVerse = 0
  for (const n of verses.keys()) if (n > lastVerse) lastVerse = n
  const info: ReferenceInfo = { path, name, lastVerse, verses }
  index.byName.set(name, info)
  if (verses.size) {
    const folded = new Map<number, string>()
    for (const [n, t] of verses) folded.set(n, foldAccents(t))
    index.searchText.set(info, folded)
  }
}
