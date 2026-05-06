// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import * as Y from 'yjs'
import type { IndexContributor } from '../IndexContributor'
import type { AnchorIndex } from '../AnchorIndex'
import { createRelPos, anchorKey, validateEntry } from '../AnchorIndex'

const HASHTAG_RE = /#[\w\u00C0-\u017E]+/g

export class HashtagContributor implements IndexContributor {
  readonly namespace = 'hashtags'
  private _processedSeq = -1
  get processedSeq() { return this._processedSeq }

  restore(_snapshot: string, seq: number): void { this._processedSeq = seq }
  snapshot(): string { return '{}' }
  onOp(seq: number | null, _docId: string, _path: string, _content: string): void {
    if (seq !== null) this._processedSeq = seq
  }

  onYjsChange(ytext: Y.Text, ydoc: Y.Doc, docId: string, index: AnchorIndex): void {
    const text = ytext.toString()

    for (const entry of index.getByDoc(this.namespace, docId)) {
      if (validateEntry(entry, ydoc) === 'invalid') index.remove(entry.id)
    }

    HASHTAG_RE.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = HASHTAG_RE.exec(text)) !== null) {
      const a1 = createRelPos(ytext, m.index, 0)
      const a2 = createRelPos(ytext, m.index + m[0].length, -1)
      const id = `${this.namespace}|${docId}|${anchorKey(a1)}|${anchorKey(a2)}`
      index.add({ id, namespace: this.namespace, value: m[0], docId, anchor1: a1, anchor2: a2 })
    }
  }
}
