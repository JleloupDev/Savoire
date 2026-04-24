// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import type { IndexContributor } from '@savoire/plugin-api'

// Built-in contributor registered by the application itself (not a plugin).
// Indexes document stems so the index can resolve [[PageName]] to a vault path.
export class FilenameIndexContributor implements IndexContributor {
  readonly namespace = 'filename'

  private readonly index = new Map<string, { path: string; stem: string }>()
  private _processedSeq = -1

  get processedSeq(): number { return this._processedSeq }

  restore(snapshot: string, processedSeq: number): void {
    try {
      const data = JSON.parse(snapshot) as Record<string, { path: string; stem: string }>
      this.index.clear()
      for (const [docId, entry] of Object.entries(data)) {
        this.index.set(docId, entry)
      }
      this._processedSeq = processedSeq
    } catch (err) {
      console.warn('[FilenameIndexContributor] restore failed:', err)
    }
  }

  onOp(seq: number | null, docId: string, path: string, _content: string): void {
    const basename = path.split('/').pop() ?? path
    const stem = basename.includes('.') ? basename.slice(0, basename.lastIndexOf('.')) : basename
    this.index.set(docId, { path, stem })
    if (seq !== null) this._processedSeq = seq
  }

  snapshot(): string {
    return JSON.stringify(Object.fromEntries(this.index))
  }

  resolveByName(name: string): string | undefined {
    for (const { path, stem } of this.index.values()) {
      if (stem === name || path === name) return path
    }
    return undefined
  }
}
