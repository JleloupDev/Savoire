// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import type { ICollaborativeText } from './ICollaborativeText'
import type { AnchorContributor } from './IndexContributor'
import type { CrdtVersion } from './CrdtVersion'
import { AnchorIndex } from './AnchorIndex'

export class IndexEngine {
  private readonly _index = new AnchorIndex()
  private readonly contributors: AnchorContributor[] = []

  // ── Query delegation ───────────────────────────────────────────────────────

  get size(): number { return this._index.size }
  get revalidationQueue(): ReadonlySet<string> { return this._index.revalidationQueue }

  getByValue(namespace: string, value: string): ReturnType<AnchorIndex['getByValue']> {
    return this._index.getByValue(namespace, value)
  }

  getByDoc(namespace: string, docId: string): ReturnType<AnchorIndex['getByDoc']> {
    return this._index.getByDoc(namespace, docId)
  }

  query(namespace: string): ReturnType<AnchorIndex['query']> {
    return this._index.query(namespace)
  }

  checkStaleness(docId: string, current: CrdtVersion): void {
    this._index.checkStaleness(docId, current)
  }

  // ── Registration ───────────────────────────────────────────────────────────

  register(contributor: AnchorContributor): this {
    this.contributors.push(contributor)
    return this
  }

  // ── Event handlers ─────────────────────────────────────────────────────────

  // Called on every CRDT text change. Drives anchor-based contributors.
  onTextChange(text: ICollaborativeText, docId: string, version?: CrdtVersion): void {
    for (const c of this.contributors) {
      c.onTextChange?.(text, docId, this._index)
    }
    this._index.markValidated(docId, version)
    this._index.revalidationQueue.delete(docId)
  }

}
