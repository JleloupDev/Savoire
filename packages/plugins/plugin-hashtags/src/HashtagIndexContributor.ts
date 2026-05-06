// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import type { IndexContributor, ICollaborativeText, AnchorIndex } from '@savoire/plugin-api'
import { validateEntry, anchorKey } from '@savoire/plugin-api'

// Matches hashtags including accented characters (e.g. #salut, #été).
const HASHTAG_RE_ANCHOR = /(?<![[\w])#[\w\u00C0-\u017E]+/g
const HASHTAG_RE_OP     = /(?<![[\w])#[\w\u00C0-\u017E]+/g

function extractHashtags(content: string): string[] {
  const tags: string[] = []
  let m: RegExpExecArray | null
  HASHTAG_RE_OP.lastIndex = 0
  while ((m = HASHTAG_RE_OP.exec(content)) !== null) tags.push(m[0].slice(1).toLowerCase())
  return [...new Set(tags)]
}

export class HashtagIndexContributor implements IndexContributor {
  readonly namespace = 'hashtags'

  // onOp-maintained map for panel queries
  private readonly byDoc = new Map<string, { path: string; tags: Set<string> }>()
  private _processedSeq = -1

  get processedSeq(): number { return this._processedSeq }

  restore(snapshot: string, processedSeq: number): void {
    try {
      const data = JSON.parse(snapshot) as Record<string, { path: string; tags: string[] }>
      this.byDoc.clear()
      for (const [docId, { path, tags }] of Object.entries(data)) {
        this.byDoc.set(docId, { path, tags: new Set(tags) })
      }
      this._processedSeq = processedSeq
    } catch (err) {
      console.warn('[HashtagIndexContributor] restore failed:', err)
    }
  }

  onOp(seq: number | null, docId: string, path: string, markdownContent: string): void {
    const tags = extractHashtags(markdownContent)
    if (tags.length > 0) this.byDoc.set(docId, { path, tags: new Set(tags) })
    else this.byDoc.delete(docId)
    if (seq !== null) this._processedSeq = seq
  }

  snapshot(): string {
    const data: Record<string, { path: string; tags: string[] }> = {}
    for (const [docId, { path, tags }] of this.byDoc) data[docId] = { path, tags: [...tags] }
    return JSON.stringify(data)
  }

  // onTextChange: maintains real-time anchor positions in AnchorIndex
  onTextChange(text: ICollaborativeText, docId: string, index: AnchorIndex): void {
    const str = text.toString()
    for (const entry of index.getByDoc(this.namespace, docId)) {
      if (validateEntry(entry, text) === 'invalid') index.remove(entry.id)
    }
    HASHTAG_RE_ANCHOR.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = HASHTAG_RE_ANCHOR.exec(str)) !== null) {
      const value = m[0]
      const start = m.index
      const end = start + value.length
      const a1 = text.createRelPos(start, 0)
      const a2 = text.createRelPos(end, -1)
      const id = `${this.namespace}|${docId}|${anchorKey(a1)}|${anchorKey(a2)}`
      index.add({ id, namespace: this.namespace, value, docId, anchor1: a1, anchor2: a2 })
    }
  }

  getHashtagsForDoc(docId: string): string[] {
    return [...(this.byDoc.get(docId)?.tags ?? [])]
  }

  getDocsForHashtag(tag: string): Array<{ docId: string; path: string }> {
    const results: Array<{ docId: string; path: string }> = []
    for (const [docId, { path, tags }] of this.byDoc) {
      if (tags.has(tag.toLowerCase())) results.push({ docId, path })
    }
    return results
  }

  getAllTags(): string[] {
    const all = new Set<string>()
    for (const { tags } of this.byDoc.values()) for (const t of tags) all.add(t)
    return [...all].sort()
  }
}
