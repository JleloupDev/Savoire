// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Un editeur de code relie a un texte partage (edite a plusieurs) : celui du
// fichier .app et des fichiers de code (JSON, JS, CSS) de ses dossiers.
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { html } from '@codemirror/lang-html'
import { defaultHighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { Annotation, Compartment, EditorState, Transaction, type ChangeSpec, type Extension } from '@codemirror/state'
import { EditorView, keymap, lineNumbers } from '@codemirror/view'
import type { FileContext, ISharedText, TextDelta } from '@savoire/plugin-api'

const fromShared = Annotation.define<boolean>()

/** Texte partage <-> CodeMirror : nos frappes partent, celles des autres arrivent. */
function bind(view: EditorView, text: ISharedText): () => void {
  return text.onChange((delta: TextDelta, origin) => {
    if (origin !== 'remote') return
    const changes: ChangeSpec[] = []
    let pos = 0
    for (const op of delta) {
      if ('retain' in op) pos += op.retain
      else if ('delete' in op) { changes.push({ from: pos, to: pos + op.delete }); pos += op.delete }
      else changes.push({ from: pos, insert: op.insert })
    }
    try {
      view.dispatch({ changes, annotations: [fromShared.of(true), Transaction.addToHistory.of(false)] })
    } catch { /* hors bornes : realigne plus bas */ }
    const expected = text.toString()
    if (view.state.doc.toString() !== expected) {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: expected }, annotations: [fromShared.of(true), Transaction.addToHistory.of(false)] })
    }
  })
}

export async function readContent(path: string, ctx: FileContext): Promise<string> {
  const vault = ctx.vault
  if (!vault) return ''
  const id = vault.resolveDocumentId(path)
  return id ? vault.read(id) : vault.readDocumentByPath(path)
}

export interface CodeEditor {
  view: EditorView
  setReadOnly(ro: boolean): void
  destroy(): void
}

/**
 * Un editeur dans `parent`, sur `doc` ; `text` : le texte partage a suivre
 * (absent : lecture seule). `onChange` : le texte a change (nous ou les autres).
 */
export function createCodeEditor(opts: {
  parent: HTMLElement
  doc: string
  text?: ISharedText
  readOnly: boolean
  language?: 'html' | 'plain'
  onChange?: (doc: string) => void
}): CodeEditor {
  let readOnly = opts.readOnly || !opts.text
  const editable = new Compartment()
  const editableExt = () => [EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)]
  const lang: Extension[] = opts.language === 'html' ? [html(), syntaxHighlighting(defaultHighlightStyle, { fallback: true })] : []
  const text = opts.text
  const view = new EditorView({
    parent: opts.parent,
    state: EditorState.create({
      doc: opts.doc,
      extensions: [
        lineNumbers(), history(), EditorView.lineWrapping, ...lang,
        keymap.of([indentWithTab, ...defaultKeymap, ...historyKeymap]),
        editable.of(editableExt()),
        EditorView.updateListener.of(u => {
          if (!u.docChanged) return
          for (const tr of u.transactions) {
            if (!tr.docChanged || tr.annotation(fromShared) || !text) continue
            const delta: TextDelta = []
            let pos = 0
            tr.changes.iterChanges((fromA, toA, _fb, _tb, inserted) => {
              if (fromA > pos) delta.push({ retain: fromA - pos })
              if (toA > fromA) delta.push({ delete: toA - fromA })
              if (inserted.length) delta.push({ insert: inserted.toString() })
              pos = toA
            })
            text.applyDelta(delta)
          }
          opts.onChange?.(u.state.doc.toString())
        }),
      ],
    }),
  })
  const unbind = text ? bind(view, text) : null
  return {
    view,
    setReadOnly(ro: boolean) {
      const next = ro || !text
      if (next === readOnly) return
      readOnly = next
      view.dispatch({ effects: editable.reconfigure(editableExt()) })
    },
    destroy() {
      unbind?.()
      view.destroy()
    },
  }
}
