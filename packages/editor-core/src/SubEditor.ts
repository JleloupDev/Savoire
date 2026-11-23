// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Sous-editeur : un petit editeur dans la note, pour le texte d'un objet
// (la case d'un tableau...). C'est le meme moteur que la note : un
// EditorView de CodeMirror, avec les aides de la note (raccourcis et
// commandes, mise en forme, entourer la selection, collage, correcteur,
// marques cachees hors du curseur). L'editeur hote les fournit par la
// facette subEditorExtensions : une aide ajoutee a la note l'est aussi la.

import { EditorView } from '@codemirror/view'
import { EditorState, Facet, Prec, Transaction, type ChangeSpec, type Extension } from '@codemirror/state'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { syntaxHighlighting, defaultHighlightStyle } from '@codemirror/language'

/** Ce que la note donne a ses sous-editeurs (aides, raccourcis, rendu des marques). */
export const subEditorExtensions = Facet.define<Extension, readonly Extension[]>()

/** La note d'un sous-editeur (rechercher, proprietes... agissent sur elle). */
export const subEditorHost = Facet.define<EditorView, EditorView | null>({ combine: v => v[0] ?? null })

/** La note ou agir : celle du sous-editeur, s'il en est un. */
export function hostOf(view: EditorView): EditorView {
  return view.state.facet(subEditorHost) ?? view
}

const focused = new WeakMap<EditorView, EditorView>()

/** Le sous-editeur de la note qui a le focus, s'il y en a un (la barre d'outils y ecrit). */
export function focusedSubEditor(host: EditorView): EditorView | null {
  const sub = focused.get(host)
  return sub && sub.hasFocus ? sub : null
}

/**
 * Une seule ligne : un retour a la ligne colle ou insere devient une espace.
 * Meme longueur : la selection de la transaction reste juste.
 */
const singleLine = EditorState.transactionFilter.of(tr => {
  if (!tr.docChanged || tr.newDoc.lines === 1) return tr
  const changes: ChangeSpec[] = []
  tr.changes.iterChanges((from, to, _f, _t, inserted) => changes.push({ from, to, insert: inserted.toString().replace(/\n/g, ' ') }))
  const userEvent = tr.annotation(Transaction.userEvent)
  return {
    changes,
    selection: tr.selection,
    effects: tr.effects,
    scrollIntoView: tr.scrollIntoView,
    ...(userEvent ? { userEvent } : {}),
  }
})

const theme = EditorView.theme({
  // Les regles de la note (hauteur pleine, colonne centree, marges, police
  // du code) ne valent pas ici : le texte garde l'allure de son objet.
  '&.plume-subeditor': {
    height: 'auto !important', background: 'transparent !important',
    fontFamily: 'inherit !important', fontSize: 'inherit !important', color: 'inherit',
  },
  '&.plume-subeditor.cm-focused': { outline: 'none' },
  '&.plume-subeditor .cm-scroller': {
    overflow: 'visible', padding: '0 !important', fontFamily: 'inherit !important', lineHeight: 'inherit',
  },
  '&.plume-subeditor .cm-content': {
    maxWidth: 'none', margin: '0 !important', padding: '0 !important',
    fontFamily: 'inherit !important', fontSize: 'inherit', lineHeight: 'inherit', whiteSpace: 'pre-wrap',
  },
  '&.plume-subeditor .cm-line': { padding: '0', lineHeight: 'inherit' },
})

export interface SubEditorOptions {
  /** Le texte a modifier. */
  doc: string
  /** Pas de retour a la ligne (case d'un tableau). */
  singleLine?: boolean
  /** Ou poser le curseur. */
  caret?: 'start' | 'end'
  /** Les touches de l'objet (Tab, Entree, fleches au bord...) : avant celles de la note. */
  keydown?: (event: KeyboardEvent, view: EditorView) => boolean
  /** Le texte a change (frappe, collage, annulation). */
  onChange?: (text: string, view: EditorView) => void
  /** Une classe de plus sur l'editeur. */
  className?: string
}

/** Un sous-editeur de la note `host`, place dans `parent`. */
export function createSubEditor(host: EditorView, parent: HTMLElement, opts: SubEditorOptions): EditorView {
  const keydown = opts.keydown
  return new EditorView({
    parent,
    state: EditorState.create({
      doc: opts.doc,
      selection: { anchor: opts.caret === 'start' ? 0 : opts.doc.length },
      extensions: [
        // Les touches de l'objet d'abord, puis celles de la note (raccourcis compris).
        ...(keydown ? [Prec.highest(EditorView.domEventHandlers({ keydown: (e, v) => keydown(e, v) }))] : []),
        subEditorHost.of(host),
        ...host.state.facet(subEditorExtensions),
        ...(opts.singleLine ? [singleLine] : []),
        EditorState.readOnly.of(host.state.readOnly),
        markdown({ base: markdownLanguage }),
        syntaxHighlighting(defaultHighlightStyle),
        EditorView.editorAttributes.of({ class: `plume-subeditor${opts.className ? ` ${opts.className}` : ''}` }),
        theme,
        EditorView.updateListener.of(u => {
          if (u.focusChanged) {
            if (u.view.hasFocus) focused.set(host, u.view)
            else if (focused.get(host) === u.view) focused.delete(host)
          }
          if (u.docChanged) opts.onChange?.(u.state.doc.toString(), u.view)
        }),
      ],
    }),
  })
}
