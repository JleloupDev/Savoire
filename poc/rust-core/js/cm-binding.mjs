// Lien CodeMirror 6 <-> CoreDoc (coeur Rust compile en WASM).
// Equivalent minimal de y-codemirror.next, sans Yjs :
// - frappe -> une transaction yrs par transaction CodeMirror ;
// - mise a jour distante -> delta rendu par le coeur -> changements CodeMirror ;
// - annuler / retablir par l'UndoManager du coeur (seulement nos frappes) ;
// - positions relatives (format Yjs) pour garder une selection a travers la synchro.
// Le transport reseau reste en JS : `send(update)` est fourni par l'appelant.

import { Annotation, EditorSelection } from '@codemirror/state'
import { ViewPlugin, keymap } from '@codemirror/view'

/** Marque les transactions qui viennent du coeur (distant, annulation). */
export const fromCore = Annotation.define()

/** Delta plat du coeur [op, val, ...] -> changements CodeMirror (coordonnees d'avant). */
export function deltaToChanges(flat) {
  const changes = []
  let pos = 0
  for (let i = 0; i < flat.length; i += 2) {
    const op = flat[i]
    const v = flat[i + 1]
    if (op === 0) pos += v
    else if (op === 1) changes.push({ from: pos, insert: v })
    else {
      changes.push({ from: pos, to: pos + v })
      pos += v
    }
  }
  return changes
}

/**
 * @param {import('../pkg/savoire_core.js').CoreDoc} core
 * @param {{ send: (update: Uint8Array) => void }} opts
 */
export function rustCollab(core, { send }) {
  const plugin = ViewPlugin.fromClass(
    class {
      constructor(view) {
        this.view = view
      }
      update(update) {
        for (const tr of update.transactions) {
          if (!tr.docChanged || tr.annotation(fromCore)) continue
          const ranges = []
          const inserts = []
          tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
            ranges.push(fromA, toA)
            inserts.push(inserted.toString())
          })
          const u = core.edit(Uint32Array.from(ranges), inserts)
          if (u.length) send(u)
        }
      }
    },
  )

  const applyCoreDelta = (view, flat) => {
    if (flat.length === 0) return
    view.dispatch({ changes: deltaToChanges(flat), annotations: fromCore.of(true) })
  }

  const run = (which) => (view) => {
    const flat = which === 'undo' ? core.undo() : core.redo()
    applyCoreDelta(view, flat)
    const u = core.takeOutbox()
    if (u.length) send(u)
    return true
  }

  return {
    extension: [
      plugin,
      keymap.of([
        { key: 'Mod-z', run: run('undo'), preventDefault: true },
        { key: 'Mod-y', mac: 'Mod-Shift-z', run: run('redo'), preventDefault: true },
      ]),
    ],
    /** A appeler par le transport quand une mise a jour arrive. */
    receive(view, update) {
      applyCoreDelta(view, core.applyUpdate(update))
    },
    undo: run('undo'),
    redo: run('redo'),
    /** Selection -> positions relatives (survivent aux mises a jour distantes). */
    saveSelection(view) {
      const { anchor, head } = view.state.selection.main
      return { anchor: core.relativePosition(anchor, 1), head: core.relativePosition(head, 1) }
    },
    restoreSelection(view, saved) {
      const a = core.resolvePosition(saved.anchor)
      const h = core.resolvePosition(saved.head)
      if (a < 0 || h < 0) return
      view.dispatch({ selection: EditorSelection.single(a, h), annotations: fromCore.of(true) })
    },
  }
}
