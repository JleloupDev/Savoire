// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import * as Y from 'yjs'
import type { ICollaborativeText } from '../ICollaborativeText'
import type { RelPosJSON } from '../AnchorHandle'

// Wraps a Y.Text + Y.Doc as an ICollaborativeText — used in tests only.
// Production code uses YjsCollaborativeText in infrastructure-sync.
export class YjsTestText implements ICollaborativeText {
  constructor(readonly ytext: Y.Text, readonly ydoc: Y.Doc) {}

  toString(): string { return this.ytext.toString() }
  get length(): number { return this.ytext.length }

  createRelPos(index: number, assoc: 0 | -1): RelPosJSON {
    const rp = Y.createRelativePositionFromTypeIndex(this.ytext, index, assoc)
    return Y.relativePositionToJSON(rp) as RelPosJSON
  }

  resolveRelPos(rp: RelPosJSON): number | null {
    const abs = Y.createAbsolutePositionFromRelativePosition(
      Y.createRelativePositionFromJSON(rp),
      this.ydoc,
    )
    return abs?.index ?? null
  }

  slice(start: number, end: number): string {
    return this.toString().slice(start, end)
  }
}

export function makeDoc(str: string): { doc: Y.Doc; ytext: Y.Text; text: YjsTestText } {
  const doc = new Y.Doc()
  doc.gc = false
  const ytext = doc.getText('content')
  ytext.insert(0, str)
  return { doc, ytext, text: new YjsTestText(ytext, doc) }
}

export function cloneDoc(source: Y.Doc): { doc: Y.Doc; ytext: Y.Text; text: YjsTestText } {
  const doc = new Y.Doc()
  doc.gc = false
  Y.applyUpdate(doc, Y.encodeStateAsUpdate(source))
  const ytext = doc.getText('content')
  return { doc, ytext, text: new YjsTestText(ytext, doc) }
}

export function syncTo(source: Y.Doc, target: Y.Doc): void {
  Y.applyUpdate(target, Y.encodeStateAsUpdate(source, Y.encodeStateVector(target)))
}
