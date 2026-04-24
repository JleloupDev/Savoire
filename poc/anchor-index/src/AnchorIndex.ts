// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import * as Y from 'yjs'

// ── Types ──────────────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type RelPosJSON = Record<string, any>

export interface IndexEntry {
  id: string           // decided by the contributor — no ID logic in the core
  namespace: string
  value: string
  docId: string
  anchor1?: RelPosJSON // absent for metadata entries (Pattern C)
  anchor2?: RelPosJSON
  meta?: unknown
}

// ── Anchor utilities (exposed to contributors) ────────────────────────────────

export function anchorKey(a: RelPosJSON): string {
  const item = a['item'] as { client: number; clock: number } | null | undefined
  const assoc = (a['assoc'] as number | undefined) ?? 0
  if (item) return `${item.client}:${item.clock}:${assoc}`
  return `tname:${(a['tname'] as string | undefined) ?? ''}:${assoc}`
}

// assoc=0 (right-sticky): anchor moves right when text inserted before it.
// assoc=-1 (left-sticky): anchor stays when text inserted after it.
export function createRelPos(ytext: Y.Text, index: number, assoc: number): RelPosJSON {
  return Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(ytext, index, assoc))
}

export function resolveRelPos(rp: RelPosJSON, ydoc: Y.Doc): number | null {
  const abs = Y.createAbsolutePositionFromRelativePosition(
    Y.createRelativePositionFromJSON(rp),
    ydoc,
  )
  return abs?.index ?? null
}

export function resolveEntry(
  entry: IndexEntry,
  ydoc: Y.Doc,
): { start: number; end: number; currentValue: string } | null {
  if (!entry.anchor1 || !entry.anchor2) return null
  const ytext = ydoc.getText('content')
  const start = resolveRelPos(entry.anchor1, ydoc)
  const end = resolveRelPos(entry.anchor2, ydoc)
  if (start === null || end === null) return null
  return { start, end, currentValue: ytext.toString().slice(start, end) }
}

export function validateEntry(entry: IndexEntry, ydoc: Y.Doc): 'valid' | 'invalid' {
  const resolved = resolveEntry(entry, ydoc)
  if (!resolved) return 'invalid'
  return resolved.currentValue === entry.value ? 'valid' : 'invalid'
}

// ── AnchorIndex — simple store ─────────────────────────────────────────────────

interface DocMeta {
  lastValidatedAt: number
}

export class AnchorIndex {
  private readonly _entries = new Map<string, IndexEntry>()
  private readonly _docMeta = new Map<string, DocMeta>()
  readonly revalidationQueue = new Set<string>()

  add(entry: IndexEntry): void {
    this._entries.set(entry.id, entry)
  }

  remove(id: string): void {
    this._entries.delete(id)
  }

  query(namespace: string): IndexEntry[] {
    return [...this._entries.values()].filter(e => e.namespace === namespace)
  }

  getByValue(namespace: string, value: string): IndexEntry[] {
    return [...this._entries.values()].filter(e => e.namespace === namespace && e.value === value)
  }

  getByDoc(namespace: string, docId: string): IndexEntry[] {
    return [...this._entries.values()].filter(e => e.namespace === namespace && e.docId === docId)
  }

  get size(): number {
    return this._entries.size
  }

  markValidated(docId: string): void {
    this._docMeta.set(docId, { lastValidatedAt: Date.now() })
    this.revalidationQueue.delete(docId)
  }

  checkStaleness(docId: string, serverUpdatedAt: number): void {
    const meta = this._docMeta.get(docId)
    const hasEntries = [...this._entries.values()].some(e => e.docId === docId)
    if (hasEntries && (!meta || serverUpdatedAt > meta.lastValidatedAt)) {
      this.revalidationQueue.add(docId)
    }
  }
}
