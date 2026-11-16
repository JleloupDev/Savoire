// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Les notes d'une Bible, au format que lit references.ts :
//
//   Bible/Bible.md                    index : la Bible installee, ses livres
//   Bible/01 - Genèse/Genèse.md       livre : tag Bible/Book, alias, chapitres
//   Bible/01 - Genèse/Genèse 1.md     chapitre : tag Bible/Chapter, versets
//
// Un verset est un bloc : ses lignes en italique, puis la reference marquee
// « ^numero », pour l'integration ![[Genèse 1#^3]].
import type { BibleBook } from './books'
import type { ParsedVerse } from './wol'

const pad = (n: number) => String(n).padStart(2, '0')

/** « Bible/ » -> « Bible/01 - Genèse/ » */
export function bookFolder(root: string, book: BibleBook): string {
  return `${root}${pad(book.number)} - ${book.name}/`
}

export function chapterPath(root: string, book: BibleBook, chapter: number): string {
  return `${bookFolder(root, book)}${book.name} ${chapter}.md`
}

export function bookPath(root: string, book: BibleBook): string {
  return `${bookFolder(root, book)}${book.name}.md`
}

export function indexPath(root: string): string {
  return `${root}Bible.md`
}

/** Une valeur YAML sur une ligne, entre guillemets si besoin. */
function yaml(value: string): string {
  return /^[\p{L}\p{N} ._()-]+$/u.test(value) && !/^[\d.]+$/.test(value) ? value : JSON.stringify(value)
}

function frontmatter(tag: string, aliases: string[], extra: [string, string][] = []): string {
  const lines = ['---', 'tags:', `- ${tag}`]
  if (aliases.length) lines.push('aliases:', ...aliases.map(a => `- ${yaml(a)}`))
  for (const [k, v] of extra) lines.push(`${k}: ${yaml(v)}`)
  lines.push('---')
  return lines.join('\n') + '\n'
}

/** Une ligne en italique ; un « * » du texte est echappe. */
const italic = (line: string) => `*${line.replace(/\*/g, '\\*')}*`

export function chapterNote(book: BibleBook, chapter: number, verses: ParsedVerse[]): string {
  const aliases = book.aliases.map(a => `${a} ${chapter}`)
  const blocks = verses.map(v =>
    [...v.lines.map(italic), `*${book.name} ${chapter} : ${v.number}*^${v.number}`].join('\n'))
  return frontmatter('Bible/Chapter', aliases) + blocks.join('\n\n') + '\n'
}

export function bookNote(book: BibleBook): string {
  const links = Array.from({ length: book.chapters }, (_, i) => `[[${book.name} ${i + 1}]]`)
  return frontmatter('Bible/Book', book.aliases) + links.join('\n') + '\n'
}

export interface IndexInfo {
  id: string
  name: string
  source: string
}

export function indexNote(root: string, books: readonly BibleBook[], bible: IndexInfo): string {
  const fm = ['---', `bible: ${yaml(bible.id)}`, `name: ${yaml(bible.name)}`, `source: ${yaml(bible.source)}`, '---'].join('\n')
  const links = books.map(b => `- [[${bookPath(root, b).replace(/\.md$/, '')}|${b.name}]]`)
  return `${fm}\n# ${bible.name}\n\n${links.join('\n')}\n`
}

/** L'id de la Bible installee, lu dans la note d'index (null : aucune ou inconnue). */
export function installedBibleId(indexText: string | null | undefined): string | null {
  if (!indexText) return null
  const m = /^---\r?\n[\s\S]*?^bible:\s*"?([^"\r\n]+)"?\s*$/m.exec(indexText)
  return m ? m[1].trim() : null
}
