// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Compter les mots d'une note pour la barre d'etat : le texte lu, sans les
// proprietes (frontmatter), sans la syntaxe Markdown ni les adresses des liens.

export interface TextStats {
  words: number
  characters: number
  /** Minutes de lecture, a 230 mots par minute (au moins 1 s'il y a du texte). */
  readingMinutes: number
}

const WORD_RE = /[\p{L}\p{N}]+(?:['’\-.][\p{L}\p{N}]+)*/gu

/** Le texte lisible d'un passage Markdown. */
export function readableText(markdown: string): string {
  return markdown
    .replace(/^---\n[\s\S]*?\n---(?:\n|$)/, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/^```.*$/gm, '')
    .replace(/!\[\[[^\]]*\]\]/g, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[\[([^\]|#]*)(?:#[^\]|]*)?(?:\|([^\]]*))?\]\]/g, (_m, page: string, alias?: string) => alias ?? page)
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[\^[^\]]+\]:?/g, '')
    .replace(/^\s*(?:#{1,6}\s+|>\s?|[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+)/gm, '')
    .replace(/[*_~=`|]+/g, ' ')
}

export function textStats(markdown: string): TextStats {
  const text = readableText(markdown)
  const words = text.match(WORD_RE)?.length ?? 0
  const characters = text.replace(/\s+/g, ' ').trim().length
  return { words, characters, readingMinutes: words === 0 ? 0 : Math.max(1, Math.round(words / 230)) }
}

/** Mots d'un texte deja lisible (une selection). */
export function countWords(text: string): number {
  return readableText(text).match(WORD_RE)?.length ?? 0
}
