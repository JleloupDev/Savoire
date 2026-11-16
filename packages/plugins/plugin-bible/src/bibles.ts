// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Les Bibles que le plugin sait telecharger. Une seule pour l'instant.
// Une Bible dit ou lire un chapitre et comment le decouper ; les notes
// produites ont toujours le meme format (voir notes.ts).
import { parseWolChapter, wolChapterUrl, type ParsedVerse, type WolEdition } from './wol'

export interface BibleEdition {
  /** Stable : ecrit dans la note d'index du dossier (« bible: tmn-fr »). */
  id: string
  name: string
  /** Abreviation courte : « TMN ». */
  short: string
  language: string
  description: string
  /** Site lu (le droit network:<site> du plugin). */
  site: string
  chapterUrl(book: number, chapter: number): string
  parseChapter(html: string, book: number, chapter: number): ParsedVerse[]
}

function wolEdition(base: Omit<BibleEdition, 'chapterUrl' | 'parseChapter' | 'site'>, wol: WolEdition): BibleEdition {
  return {
    ...base,
    site: 'wol.jw.org',
    chapterUrl: (book, chapter) => wolChapterUrl(wol, book, chapter),
    parseChapter: parseWolChapter,
  }
}

export const BIBLES: readonly BibleEdition[] = [
  wolEdition(
    {
      id: 'tmn-fr',
      name: 'Traduction du monde nouveau (révision 2018)',
      short: 'TMN',
      language: 'fr',
      description: 'Lue sur wol.jw.org, chapitre par chapitre.',
    },
    { language: 'fr', rsconf: 'r30', lib: 'lp-f', publication: 'nwt' },
  ),
]

export function bibleById(id: string): BibleEdition | undefined {
  return BIBLES.find(b => b.id === id)
}
