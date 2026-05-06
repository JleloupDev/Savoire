// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import type { IndexContributor, ICollaborativeText, AnchorIndex, IndexEntry } from '@savoire/plugin-api'
import { anchorKey } from '@savoire/plugin-api'

export interface HeadingMeta { level: number }

const HEADING_RE = /^(#{1,6}) (.+)$/gm

function validateHeading(entry: IndexEntry, text: ICollaborativeText): 'valid' | 'invalid' {
  if (!entry.anchor1 || !entry.anchor2) return 'invalid'
  const start = text.resolveRelPos(entry.anchor1)
  const end = text.resolveRelPos(entry.anchor2)
  if (start === null || end === null) return 'invalid'
  const meta = entry.meta as HeadingMeta
  const expected = '#'.repeat(meta.level) + ' ' + entry.value
  return text.slice(start, end) === expected ? 'valid' : 'invalid'
}

export function headingToAnchor(heading: string): string {
  return heading.toLowerCase().replace(/\s+/g, '-').replace(/[^\w-]/g, '')
}

export class HeadingIndexContributor implements IndexContributor {
  readonly namespace = 'headings'

  // onOp-maintained map for [[Page#Heading]] resolution
  private readonly byDoc = new Map<string, { path: string; headings: string[] }>()
  private _processedSeq = -1

  get processedSeq(): number { return this._processedSeq }

  restore(snapshot: string, processedSeq: number): void {
    try {
      const data = JSON.parse(snapshot) as Record<string, { path: string; headings: string[] }>
      this.byDoc.clear()
      for (const [docId, entry] of Object.entries(data)) this.byDoc.set(docId, entry)
      this._processedSeq = processedSeq
    } catch (err) {
      console.warn('[HeadingIndexContributor] restore failed:', err)
    }
  }

  onOp(seq: number | null, docId: string, path: string, markdownContent: string): void {
    const headings: string[] = []
    let m: RegExpExecArray | null
    HEADING_RE.lastIndex = 0
    while ((m = HEADING_RE.exec(markdownContent)) !== null) headings.push(m[2].trim())
    if (headings.length > 0) this.byDoc.set(docId, { path, headings })
    else this.byDoc.delete(docId)
    if (seq !== null) this._processedSeq = seq
  }

  snapshot(): string {
    return JSON.stringify(Object.fromEntries(this.byDoc))
  }

  // onTextChange: maintains real-time anchor positions in AnchorIndex
  onTextChange(text: ICollaborativeText, docId: string, index: AnchorIndex): void {
    const str = text.toString()
    for (const entry of index.getByDoc(this.namespace, docId)) {
      if (validateHeading(entry, text) === 'invalid') index.remove(entry.id)
    }
    HEADING_RE.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = HEADING_RE.exec(str)) !== null) {
      const level = m[1].length
      const headingText = m[2]
      const start = m.index
      const end = m.index + m[0].length
      const a1 = text.createRelPos(start, 0)
      const a2 = text.createRelPos(end, -1)
      const id = `${this.namespace}|${docId}|${anchorKey(a1)}|${anchorKey(a2)}`
      const meta: HeadingMeta = { level }
      index.add({ id, namespace: this.namespace, value: headingText, docId, anchor1: a1, anchor2: a2, meta })
    }
  }

  getHeadingsForPath(targetPath: string): string[] {
    for (const { path, headings } of this.byDoc.values()) {
      if (path === targetPath) return headings
    }
    const stem = (targetPath.split('/').pop() ?? targetPath).replace(/\.[^.]+$/, '')
    for (const { path, headings } of this.byDoc.values()) {
      const docStem = (path.split('/').pop() ?? path).replace(/\.[^.]+$/, '')
      if (docStem === stem) return headings
    }
    return []
  }
}
