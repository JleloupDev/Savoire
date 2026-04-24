// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import * as Y from 'yjs'
import type { IndexContributor } from '../IndexContributor'
import type { AnchorIndex, IndexEntry } from '../AnchorIndex'
import { createRelPos, anchorKey, resolveRelPos } from '../AnchorIndex'

export interface HeadingMeta { level: number }

// Anchres autour de la ligne COMPLÈTE (du '#' jusqu'à la fin du texte du titre).
// Exemple : "## Introduction" → anchor1 sur '#', anchor2 après 'n'.
// value = "Introduction" (sans le préfixe).
//
// DECISION: ancrer la ligne entière (pas seulement le texte) pour détecter
// toute modification du titre — y compris l'insertion de mots en début de titre.
// La validation compare slice(start, end) avec "#".repeat(level) + " " + value,
// ce qui invalide l'entrée dès que le contenu complet de la ligne change.
const HEADING_RE = /^(#{1,6}) (.+)$/gm

function validateHeading(entry: IndexEntry, ydoc: Y.Doc): 'valid' | 'invalid' {
  if (!entry.anchor1 || !entry.anchor2) return 'invalid'
  const start = resolveRelPos(entry.anchor1, ydoc)
  const end = resolveRelPos(entry.anchor2, ydoc)
  if (start === null || end === null) return 'invalid'
  const text = ydoc.getText('content').toString()
  const meta = entry.meta as HeadingMeta
  const expected = '#'.repeat(meta.level) + ' ' + entry.value
  return text.slice(start, end) === expected ? 'valid' : 'invalid'
}

export class HeadingContributor implements IndexContributor {
  readonly namespace = 'headings'
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
      if (validateHeading(entry, ydoc) === 'invalid') index.remove(entry.id)
    }

    HEADING_RE.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = HEADING_RE.exec(text)) !== null) {
      const level = m[1]!.length
      const headingText = m[2]!
      // anchor1 : début du '#' — anchor2 : fin du texte du titre
      const start = m.index
      const end = m.index + m[1]!.length + 1 + headingText.length
      const a1 = createRelPos(ytext, start, 0)
      const a2 = createRelPos(ytext, end, -1)
      const id = `${this.namespace}|${docId}|${anchorKey(a1)}|${anchorKey(a2)}`
      const meta: HeadingMeta = { level }
      index.add({ id, namespace: this.namespace, value: headingText, docId, anchor1: a1, anchor2: a2, meta })
    }
  }
}
