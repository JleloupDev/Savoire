// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import type { IndexContributor } from '@savoire/plugin-api'
import type { DocMetadata, CrdtVersion } from '@savoire/domain-index'

// Parses frontmatter and first H1 from stabilized markdown content.
// Produces Level 2 metadata (title, tags, aliases, raw frontmatter).
// crdtVersion is set externally by IndexEngine after onTextChange fires.
export class MetadataIndexContributor implements IndexContributor {
  readonly namespace = 'metadata'

  private readonly store = new Map<string, DocMetadata>()
  private _processedSeq = -1

  get processedSeq(): number { return this._processedSeq }

  restore(snapshot: string, processedSeq: number): void {
    try {
      const data = JSON.parse(snapshot) as Record<string, DocMetadata>
      this.store.clear()
      for (const [docId, entry] of Object.entries(data)) this.store.set(docId, entry)
      this._processedSeq = processedSeq
    } catch (err) {
      console.warn('[MetadataIndexContributor] restore failed:', err)
    }
  }

  onOp(seq: number | null, docId: string, path: string, markdownContent: string): void {
    const frontmatter = parseFrontmatter(markdownContent)
    const title = resolveTitle(frontmatter, markdownContent)
    const tags = resolveTags(frontmatter, markdownContent)
    const aliases = resolveAliases(frontmatter)
    const existing = this.store.get(docId)
    this.store.set(docId, {
      docId,
      path,
      crdtVersion: existing?.crdtVersion ?? { clock: 0 },
      title,
      tags,
      aliases,
      frontmatter,
    })
    if (seq !== null) this._processedSeq = seq
  }

  snapshot(): string {
    return JSON.stringify(Object.fromEntries(this.store))
  }

  getMetadata(docId: string): DocMetadata | null {
    return this.store.get(docId) ?? null
  }

  getAllMetadata(): DocMetadata[] {
    return [...this.store.values()]
  }

  // Called by IndexEngine after onTextChange to attach the CRDT version to the metadata.
  updateCrdtVersion(docId: string, version: CrdtVersion): void {
    const entry = this.store.get(docId)
    if (entry) entry.crdtVersion = version
  }
}

// ── Minimal frontmatter parser ─────────────────────────────────────────────────
// Handles the most common YAML patterns without a full parser dependency.

function parseFrontmatter(markdown: string): Record<string, unknown> {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(markdown)
  if (!match) return {}
  const result: Record<string, unknown> = {}
  const lines = match[1].split(/\r?\n/)
  let currentKey: string | null = null
  let currentArray: string[] = []

  for (const line of lines) {
    if (currentKey && /^\s{2,}-\s+/.test(line)) {
      currentArray.push(line.replace(/^\s{2,}-\s+/, '').trim())
      continue
    }
    if (currentKey && currentArray.length > 0) {
      result[currentKey] = currentArray
      currentKey = null
      currentArray = []
    }
    const kv = /^([\w-]+):\s*(.*)$/.exec(line)
    if (!kv) continue
    const [, key, value] = kv
    if (!value || value === '[]') {
      currentKey = key
    } else if (value.startsWith('[') && value.endsWith(']')) {
      result[key] = value.slice(1, -1).split(',').map(s => s.trim()).filter(Boolean)
    } else {
      result[key] = value
    }
  }
  if (currentKey && currentArray.length > 0) result[currentKey] = currentArray
  return result
}

function resolveTitle(frontmatter: Record<string, unknown>, markdown: string): string {
  if (typeof frontmatter['title'] === 'string') return frontmatter['title']
  const h1 = /^#\s+(.+)$/m.exec(markdown)
  return h1 ? h1[1].trim() : ''
}

function resolveTags(frontmatter: Record<string, unknown>, markdown: string): string[] {
  const fm = frontmatter['tags']
  const fmTags = Array.isArray(fm)
    ? fm.map(String)
    : typeof fm === 'string' ? [fm] : []
  const inlineTags = [...markdown.matchAll(/(?<![[\w])#([\w\u00C0-\u017E]+)/g)].map(m => m[1])
  return [...new Set([...fmTags, ...inlineTags])]
}

function resolveAliases(frontmatter: Record<string, unknown>): string[] {
  const a = frontmatter['aliases']
  if (Array.isArray(a)) return a.map(String)
  if (typeof a === 'string') return [a]
  return []
}
