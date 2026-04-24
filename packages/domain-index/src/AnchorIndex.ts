// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import type { ICollaborativeText } from './ICollaborativeText'
import type { IndexEntry } from './IndexEntry'

// ── Utility functions ──────────────────────────────────────────────────────────

export function resolveEntry(
  entry: IndexEntry,
  text: ICollaborativeText,
): { start: number; end: number; currentValue: string } | null {
  if (!entry.anchor1 || !entry.anchor2) return null
  const start = text.resolveRelPos(entry.anchor1)
  const end = text.resolveRelPos(entry.anchor2)
  if (start === null || end === null || end <= start) return null
  return { start, end, currentValue: text.slice(start, end) }
}

export function validateEntry(entry: IndexEntry, text: ICollaborativeText): 'valid' | 'invalid' {
  const resolved = resolveEntry(entry, text)
  if (!resolved) return 'invalid'
  return resolved.currentValue === entry.value ? 'valid' : 'invalid'
}

// ── AnchorIndex store ──────────────────────────────────────────────────────────

export class AnchorIndex {
  private readonly entries = new Map<string, IndexEntry>()
  // namespace → docId → Set<entryId>
  private readonly byDoc = new Map<string, Map<string, Set<string>>>()
  // namespace → value → Set<entryId>
  private readonly byValue = new Map<string, Map<string, Set<string>>>()
  // Per-doc timestamp of last full validation (used for staleness detection)
  private readonly lastValidatedAt = new Map<string, number>()
  // Docs flagged as potentially stale (server has newer content we haven't indexed)
  readonly revalidationQueue = new Set<string>()

  get size(): number { return this.entries.size }

  add(entry: IndexEntry): void {
    const existing = this.entries.get(entry.id)
    if (existing) {
      if (existing.value === entry.value && existing.meta === entry.meta) return
      const oldValue = existing.value
      existing.value = entry.value
      existing.meta = entry.meta
      this._reindex(existing, oldValue)
      return
    }
    this.entries.set(entry.id, entry)
    this._index(entry)
  }

  remove(id: string): void {
    const entry = this.entries.get(id)
    if (!entry) return
    this._unindex(entry)
    this.entries.delete(id)
  }

  query(namespace: string): IndexEntry[] {
    const nsMap = this.byDoc.get(namespace)
    if (!nsMap) return []
    const result: IndexEntry[] = []
    for (const ids of nsMap.values()) {
      for (const id of ids) {
        const e = this.entries.get(id)
        if (e) result.push(e)
      }
    }
    return result
  }

  getByValue(namespace: string, value: string): IndexEntry[] {
    const ids = this.byValue.get(namespace)?.get(value)
    if (!ids) return []
    return [...ids].flatMap(id => {
      const e = this.entries.get(id)
      return e ? [e] : []
    })
  }

  getByDoc(namespace: string, docId: string): IndexEntry[] {
    const ids = this.byDoc.get(namespace)?.get(docId)
    if (!ids) return []
    return [...ids].flatMap(id => {
      const e = this.entries.get(id)
      return e ? [e] : []
    })
  }

  markValidated(docId: string): void {
    this.lastValidatedAt.set(docId, Date.now())
    this.revalidationQueue.delete(docId)
  }

  // Flag a doc for revalidation if the server has content newer than our last validation.
  checkStaleness(docId: string, serverUpdatedAt: number): void {
    const lastValidated = this.lastValidatedAt.get(docId) ?? -1
    const hasEntries = this._hasEntriesForDoc(docId)
    if (hasEntries && serverUpdatedAt > lastValidated) {
      this.revalidationQueue.add(docId)
    }
  }

  private _hasEntriesForDoc(docId: string): boolean {
    for (const nsMap of this.byDoc.values()) {
      const ids = nsMap.get(docId)
      if (ids && ids.size > 0) return true
    }
    return false
  }

  private _index(entry: IndexEntry): void {
    // byDoc
    let nsMap = this.byDoc.get(entry.namespace)
    if (!nsMap) { nsMap = new Map(); this.byDoc.set(entry.namespace, nsMap) }
    let docSet = nsMap.get(entry.docId)
    if (!docSet) { docSet = new Set(); nsMap.set(entry.docId, docSet) }
    docSet.add(entry.id)

    // byValue
    let valMap = this.byValue.get(entry.namespace)
    if (!valMap) { valMap = new Map(); this.byValue.set(entry.namespace, valMap) }
    let valSet = valMap.get(entry.value)
    if (!valSet) { valSet = new Set(); valMap.set(entry.value, valSet) }
    valSet.add(entry.id)
  }

  private _unindex(entry: IndexEntry): void {
    this.byDoc.get(entry.namespace)?.get(entry.docId)?.delete(entry.id)
    this.byValue.get(entry.namespace)?.get(entry.value)?.delete(entry.id)
  }

  // Called when value changes in-place: move entry from oldValue bucket to new value bucket.
  private _reindex(entry: IndexEntry, oldValue: string): void {
    this.byValue.get(entry.namespace)?.get(oldValue)?.delete(entry.id)
    let valMap = this.byValue.get(entry.namespace)
    if (!valMap) { valMap = new Map(); this.byValue.set(entry.namespace, valMap) }
    let valSet = valMap.get(entry.value)
    if (!valSet) { valSet = new Set(); valMap.set(entry.value, valSet) }
    valSet.add(entry.id)
  }
}
