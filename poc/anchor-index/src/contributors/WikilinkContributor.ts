// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import * as Y from 'yjs'
import type { IndexContributor } from '../IndexContributor'
import type { AnchorIndex } from '../AnchorIndex'
import { createRelPos, anchorKey, validateEntry } from '../AnchorIndex'

// Anchres autour du target uniquement (pas des crochets [[ ]]).
// [[target]] → anchres autour de "target"
// [[target|alias]] → valeur = "target", alias ignoré dans l'index
const WIKILINK_RE = /\[\[([^\]|#\n]+?)(?:\|[^\]]*)?\]\]/g

export class WikilinkContributor implements IndexContributor {
  readonly namespace = 'wikilinks'
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

    WIKILINK_RE.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = WIKILINK_RE.exec(text)) !== null) {
      const targetText = m[1]!
      const start = m.index + 2         // après [[
      const end = start + targetText.length
      const value = targetText.trim()
      const a1 = createRelPos(ytext, start, 0)
      const a2 = createRelPos(ytext, end, -1)
      const id = `${this.namespace}|${docId}|${anchorKey(a1)}|${anchorKey(a2)}`
      index.add({ id, namespace: this.namespace, value, docId, anchor1: a1, anchor2: a2 })
    }
  }
}
