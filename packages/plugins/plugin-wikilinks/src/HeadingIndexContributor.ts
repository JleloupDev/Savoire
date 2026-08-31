// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import type { IndexContributor, SharedIndexEntry, ICollaborativeText, AnchorIndex, IndexEntry } from '@savoire/plugin-api'
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

  // Modele de lecture pour [[Page#Heading]], reconstruit depuis la carte partagee.
  private readonly byDoc = new Map<string, { path: string; headings: string[] }>()

  computeEntries(_docId: string, path: string, markdown: string): SharedIndexEntry[] {
    const headings: string[] = []
    let m: RegExpExecArray | null
    HEADING_RE.lastIndex = 0
    while ((m = HEADING_RE.exec(markdown)) !== null) headings.push(m[2].trim())
    if (headings.length === 0) return []
    return [{ key: 'headings', value: { path, headings } }]
  }

  onEntriesChanged(byDoc: ReadonlyMap<string, SharedIndexEntry[]>): void {
    this.byDoc.clear()
    for (const [docId, entries] of byDoc) {
      const entry = entries.find(e => e.key === 'headings')
      if (!entry) continue
      this.byDoc.set(docId, entry.value as { path: string; headings: string[] })
    }
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
