// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Liaison entre une vue CodeMirror et un texte partage (ISharedText).
//
//  - ce qu'on tape dans la vue part dans le texte partage (applyDelta) ;
//  - ce qui arrive d'un autre membre ('remote') est rejoue dans la vue,
//    marque d'une annotation pour ne pas repartir dans l'autre sens.
//
// Le texte partage reste la reference : si la vue s'en ecarte (ce qui ne
// devrait pas arriver), elle est realignee en entier.
import { Annotation, Transaction, type ChangeSet, type ChangeSpec } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import type { ISharedText, TextDelta } from '@savoire/plugin-api'

/** Marque une transaction qui vient du texte partage. */
export const remoteChange = Annotation.define<boolean>()

/** Changements CodeMirror -> delta (positions dans le texte d'avant). */
export function changesToDelta(changes: ChangeSet): TextDelta {
  const delta: TextDelta = []
  let pos = 0
  changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
    if (fromA > pos) delta.push({ retain: fromA - pos })
    if (toA > fromA) delta.push({ delete: toA - fromA })
    const text = inserted.toString()
    if (text) delta.push({ insert: text })
    pos = toA
  })
  return delta
}

/** Delta -> changements CodeMirror (positions dans le document d'avant). */
export function deltaToChanges(delta: TextDelta): ChangeSpec[] {
  const out: ChangeSpec[] = []
  let pos = 0
  for (const op of delta) {
    if ('retain' in op) pos += op.retain
    else if ('delete' in op) {
      out.push({ from: pos, to: pos + op.delete })
      pos += op.delete
    } else out.push({ from: pos, insert: op.insert })
  }
  return out
}

/**
 * Branche la vue sur le texte partage. Rend l'extension a installer dans la
 * vue et une fonction `attach(view)` a appeler une fois la vue creee ; elle
 * rend le desabonnement.
 */
export function sharedTextBinding(text: ISharedText) {
  const extension = EditorView.updateListener.of(update => {
    if (!update.docChanged) return
    for (const tr of update.transactions) {
      if (!tr.docChanged || tr.annotation(remoteChange)) continue
      text.applyDelta(changesToDelta(tr.changes))
    }
  })

  function attach(view: EditorView): () => void {
    return text.onChange((delta, origin) => {
      if (origin !== 'remote') return
      const doc = view.state.doc
      let changes: ChangeSpec[] = deltaToChanges(delta)
      // Delta hors bornes : on realigne tout plutot que de planter.
      const reach = delta.reduce((n, op) => n + ('retain' in op ? op.retain : 'delete' in op ? op.delete : 0), 0)
      if (reach > doc.length) changes = [{ from: 0, to: doc.length, insert: text.toString() }]
      view.dispatch({
        changes,
        annotations: [remoteChange.of(true), Transaction.addToHistory.of(false)],
      })
      const expected = text.toString()
      if (view.state.doc.length !== expected.length || view.state.doc.toString() !== expected) {
        view.dispatch({
          changes: { from: 0, to: view.state.doc.length, insert: expected },
          annotations: [remoteChange.of(true), Transaction.addToHistory.of(false)],
        })
      }
    })
  }

  return { extension, attach }
}
