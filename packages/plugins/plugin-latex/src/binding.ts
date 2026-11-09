// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// L'editeur CodeMirror du document LaTeX, relie au texte partage du document
// (ISharedText, un CRDT) : plusieurs membres ecrivent en meme temps.
//
//  - une frappe locale part dans le texte partage, en delta ;
//  - un changement d'un autre membre est rejoue dans l'editeur, marque pour
//    ne pas repartir dans l'autre sens, et hors de l'historique d'annulation ;
//  - si l'editeur s'ecarte du texte partage, il est realigne en entier.
import { Annotation, Transaction, type ChangeSet, type ChangeSpec, type Extension } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import type { ISharedText, TextDelta } from '@savoire/plugin-api'

const fromShared = Annotation.define<boolean>()

export function toDelta(changes: ChangeSet): TextDelta {
  const delta: TextDelta = []
  let pos = 0
  changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
    if (fromA > pos) delta.push({ retain: fromA - pos })
    if (toA > fromA) delta.push({ delete: toA - fromA })
    if (inserted.length) delta.push({ insert: inserted.toString() })
    pos = toA
  })
  return delta
}

export function toChanges(delta: TextDelta): ChangeSpec[] {
  const out: ChangeSpec[] = []
  let pos = 0
  for (const op of delta) {
    if ('retain' in op) pos += op.retain
    else if ('delete' in op) { out.push({ from: pos, to: pos + op.delete }); pos += op.delete }
    else out.push({ from: pos, insert: op.insert })
  }
  return out
}

/** Extension a installer dans l'editeur, et `attach(view)` qui rend le desabonnement. */
export function bindSharedText(text: ISharedText): { extension: Extension; attach(view: EditorView): () => void } {
  const extension = EditorView.updateListener.of(update => {
    for (const tr of update.transactions) {
      if (tr.docChanged && !tr.annotation(fromShared)) text.applyDelta(toDelta(tr.changes))
    }
  })
  const attach = (view: EditorView): (() => void) => text.onChange((delta, origin) => {
    if (origin !== 'remote') return
    const annotations = [fromShared.of(true), Transaction.addToHistory.of(false)]
    const reach = delta.reduce((n, op) => n + ('retain' in op ? op.retain : 'delete' in op ? op.delete : 0), 0)
    if (reach <= view.state.doc.length) view.dispatch({ changes: toChanges(delta), annotations })
    const expected = text.toString()
    if (view.state.doc.toString() !== expected) {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: expected }, annotations })
    }
  })
  return { extension, attach }
}
