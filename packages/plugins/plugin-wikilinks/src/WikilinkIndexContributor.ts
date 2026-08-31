// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import type { IndexContributor, SharedIndexEntry, ICollaborativeText, AnchorIndex } from '@savoire/plugin-api'
import { validateEntry, anchorKey } from '@savoire/plugin-api'

export interface BacklinkEntry {
  docId: string
  path: string
}

// Capture group 1 = page target (strips optional #heading and |alias)
const WIKILINK_RE = /\[\[([^\]|#]+?)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g

function extractTargets(content: string): string[] {
  const targets: string[] = []
  let m: RegExpExecArray | null
  WIKILINK_RE.lastIndex = 0
  while ((m = WIKILINK_RE.exec(content)) !== null) targets.push(m[1].trim())
  return targets
}

export class WikilinkIndexContributor implements IndexContributor {
  readonly namespace = 'wikilinks'

  // Modele de lecture (cible -> sources), reconstruit depuis la carte partagee.
  private readonly backlinks = new Map<string, Map<string, BacklinkEntry>>()

  computeEntries(_docId: string, path: string, markdown: string): SharedIndexEntry[] {
    const targets = [...new Set(extractTargets(markdown))]
    if (targets.length === 0) return []
    return [{ key: 'targets', value: { path, targets } }]
  }

  onEntriesChanged(byDoc: ReadonlyMap<string, SharedIndexEntry[]>): void {
    this.backlinks.clear()
    for (const [docId, entries] of byDoc) {
      const entry = entries.find(e => e.key === 'targets')
      if (!entry) continue
      const { path, targets } = entry.value as { path: string; targets: string[] }
      for (const target of targets) {
        let inner = this.backlinks.get(target)
        if (!inner) { inner = new Map(); this.backlinks.set(target, inner) }
        inner.set(docId, { docId, path })
      }
    }
  }

  // onTextChange: maintains real-time anchor positions in AnchorIndex
  onTextChange(text: ICollaborativeText, docId: string, index: AnchorIndex): void {
    const str = text.toString()
    for (const entry of index.getByDoc(this.namespace, docId)) {
      if (validateEntry(entry, text) === 'invalid') index.remove(entry.id)
    }
    WIKILINK_RE.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = WIKILINK_RE.exec(str)) !== null) {
      const target = m[1].trim()
      const start = m.index + 2
      const end = start + target.length
      const a1 = text.createRelPos(start, 0)
      const a2 = text.createRelPos(end, -1)
      const id = `${this.namespace}|${docId}|${anchorKey(a1)}|${anchorKey(a2)}`
      index.add({ id, namespace: this.namespace, value: target, docId, anchor1: a1, anchor2: a2 })
    }
  }

  getBacklinks(targetPath: string): BacklinkEntry[] {
    const exact = this.backlinks.get(targetPath)
    if (exact) return [...exact.values()]
    const stem = (targetPath.split('/').pop() ?? targetPath).replace(/\.[^.]+$/, '')
    const results = new Map<string, BacklinkEntry>()
    for (const [target, inner] of this.backlinks) {
      const tStem = (target.split('/').pop() ?? target).replace(/\.[^.]+$/, '')
      if (tStem === stem || target === stem) {
        for (const [id, entry] of inner) results.set(id, entry)
      }
    }
    return [...results.values()]
  }
}
