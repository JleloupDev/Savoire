// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import MiniSearch from 'minisearch'
import type { IndexContributor } from '@savoire/plugin-api'

export interface FullTextSearchResult {
  docId: string
  path: string
  score: number
  terms: string[]
}

// Removes frontmatter and common markdown syntax to avoid indexing noise.
function stripMarkdown(md: string): string {
  return md
    .replace(/^---[\s\S]*?---\n?/, '')        // frontmatter
    .replace(/```[\s\S]*?```/g, ' ')           // code blocks
    .replace(/`[^`]+`/g, ' ')                  // inline code
    .replace(/!\[.*?\]\(.*?\)/g, ' ')          // images
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')  // links → keep label
    .replace(/#{1,6}\s/g, ' ')                 // headings markers
    .replace(/[*_~]{1,3}/g, ' ')               // bold/italic/strike
    .replace(/^\s*[-*+]\s/gm, ' ')             // list markers
    .replace(/^\s*>\s/gm, ' ')                 // blockquotes
    .replace(/\s+/g, ' ')
    .trim()
}

type DocRecord = { id: string; text: string }

export class FullTextIndexContributor implements IndexContributor {
  readonly namespace = 'fulltext'
  private _processedSeq = -1
  // docId → vault path, needed to build FullTextSearchResult
  private readonly paths = new Map<string, string>()
  private engine: MiniSearch<DocRecord>

  constructor() {
    this.engine = this.makeEngine()
  }

  get processedSeq(): number { return this._processedSeq }

  onOp(seq: number | null, docId: string, path: string, markdownContent: string): void {
    const text = stripMarkdown(markdownContent)
    if (this.engine.has(docId)) {
      this.engine.replace({ id: docId, text })
    } else {
      this.engine.add({ id: docId, text })
    }
    this.paths.set(docId, path)
    if (seq !== null) this._processedSeq = seq
  }

  snapshot(): string {
    return JSON.stringify({
      // indexJson is pre-stringified so restore() can pass it directly to loadJSON without a second JSON.stringify.
      indexJson: JSON.stringify(this.engine.toJSON()),
      paths: Object.fromEntries(this.paths),
    })
  }

  restore(snapshot: string, processedSeq: number): void {
    try {
      const data = JSON.parse(snapshot) as { indexJson: string; paths: Record<string, string> }
      this.engine = MiniSearch.loadJSON<DocRecord>(data.indexJson, this.miniSearchOptions())
      this.paths.clear()
      for (const [docId, path] of Object.entries(data.paths)) this.paths.set(docId, path)
      this._processedSeq = processedSeq
    } catch (err) {
      console.warn('[FullTextIndexContributor] restore failed:', err)
    }
  }

  search(query: string): FullTextSearchResult[] {
    if (!query.trim()) return []
    return this.engine
      .search(query, { prefix: true, fuzzy: 0.15 })
      .map(r => ({
        docId: String(r.id),
        path: this.paths.get(String(r.id)) ?? '',
        score: r.score,
        terms: r.terms,
      }))
  }

  private makeEngine(): MiniSearch<DocRecord> {
    return new MiniSearch(this.miniSearchOptions())
  }

  private miniSearchOptions(): ConstructorParameters<typeof MiniSearch<DocRecord>>[0] {
    return {
      fields: ['text'],
      idField: 'id',
      storeFields: [],  // don't store content — saves space in snapshot
    }
  }
}
