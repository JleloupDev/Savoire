// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Telecharger une Bible dans le vault : un chapitre par page lue, une note par
// chapitre, puis une note par livre et la note d'index.
//
// Une note qui existe deja n'est ni relue ni remplacee : une installation
// interrompue reprend la ou elle s'est arretee, et une Bible deja presente
// (les notes de la personne, le paquet du store) reste telle quelle.
import { BOOKS, CHAPTER_COUNT, type BibleBook } from './books'
import type { BibleEdition } from './bibles'
import { bookNote, bookPath, chapterNote, chapterPath, indexNote, indexPath } from './notes'

export interface InstallTarget {
  fetchText(url: string): Promise<string>
  exists(path: string): boolean
  /** Cree la note avec ce texte. */
  createNote(path: string, text: string): Promise<void>
}

export interface InstallProgress {
  done: number
  total: number
  written: number
  skipped: number
  current?: string
}

export interface InstallOptions {
  root: string
  /** Pages lues en meme temps. */
  concurrency?: number
  onProgress?(p: InstallProgress): void
  /** Vrai : s'arreter au plus tot (les notes deja ecrites restent). */
  cancelled?(): boolean
  books?: readonly BibleBook[]
}

export interface InstallResult {
  written: number
  skipped: number
  cancelled: boolean
}

export class BibleInstallError extends Error {}

export async function installBible(target: InstallTarget, bible: BibleEdition, opts: InstallOptions): Promise<InstallResult> {
  const books = opts.books ?? BOOKS
  const total = (opts.books ? books.reduce((n, b) => n + b.chapters, 0) : CHAPTER_COUNT) + books.length + 1
  const progress: InstallProgress = { done: 0, total, written: 0, skipped: 0 }
  const report = (current?: string) => opts.onProgress?.({ ...progress, current })
  const stop = () => opts.cancelled?.() ?? false

  const writeOnce = async (path: string, make: () => Promise<string> | string) => {
    if (target.exists(path)) progress.skipped++
    else { await target.createNote(path, await make()); progress.written++ }
    progress.done++
    report(path)
  }

  const chapters = books.flatMap(book => Array.from({ length: book.chapters }, (_, i) => ({ book, chapter: i + 1 })))
  let next = 0
  let failure: unknown = null
  const worker = async () => {
    while (next < chapters.length && !failure && !stop()) {
      const { book, chapter } = chapters[next++]
      try {
        await writeOnce(chapterPath(opts.root, book, chapter), async () => {
          const html = await target.fetchText(bible.chapterUrl(book.number, chapter))
          const verses = bible.parseChapter(html, book.number, chapter)
          if (!verses.length) throw new BibleInstallError(`Aucun verset lu pour ${book.name} ${chapter}.`)
          return chapterNote(book, chapter, verses)
        })
      } catch (err) {
        failure ??= err
      }
    }
  }
  report()
  await Promise.all(Array.from({ length: Math.max(1, opts.concurrency ?? 3) }, worker))
  if (failure) throw failure
  if (stop()) return { written: progress.written, skipped: progress.skipped, cancelled: true }

  for (const book of books) await writeOnce(bookPath(opts.root, book), () => bookNote(book))
  await writeOnce(indexPath(opts.root), () => indexNote(opts.root, books, { id: bible.id, name: bible.name, source: bible.site }))
  return { written: progress.written, skipped: progress.skipped, cancelled: false }
}
