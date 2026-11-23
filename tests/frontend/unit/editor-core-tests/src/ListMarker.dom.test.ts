// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// La ligne de liste en edition garde sa puce (ou sa case) a la place du
// `- ` brut : le texte ne se decale pas. Le tiret revient si le curseur
// entre dans le marqueur.
import { describe, it, expect } from 'vitest'
import { EditorView } from '@codemirror/view'
import { EditorState, EditorSelection } from '@codemirror/state'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { createLivePreviewExtension, type PreviewMode } from '../../../../../packages/editor-core/src/LivePreview'

const DOC = 'Avant\n\n- alpha\n  - beta\n- [ ] tache\n\nApres'

function setup(cursor: number, mode: PreviewMode = 'power') {
  const parent = document.createElement('div')
  document.body.appendChild(parent)
  return new EditorView({
    parent,
    state: EditorState.create({
      doc: DOC, selection: EditorSelection.cursor(cursor),
      extensions: [markdown({ base: markdownLanguage }), ...createLivePreviewExtension(undefined, undefined, { editorView: null }, false, undefined, mode)],
    }),
  })
}

const liveLine = (view: EditorView) => view.contentDOM.querySelector('.cm-line:has(.vault-list-marker-live), .cm-line[style*="padding-left"]') as HTMLElement

describe('Marqueur de la ligne de liste en edition', () => {
  it.each(['power', 'classic'] as const)('mode %s : la puce reste, au meme retrait que le rendu', mode => {
    const view = setup(DOC.indexOf('beta'), mode)
    const line = liveLine(view)
    expect(line.textContent).toBe('◦beta')
    expect(line.style.paddingLeft).toBe('1.5em')
    view.destroy()
  })

  it('la case a cocher reste une case', () => {
    const view = setup(DOC.indexOf('tache') + 2)
    const line = liveLine(view)
    expect(line.querySelector('input[type="checkbox"]')).not.toBeNull()
    expect(line.textContent).toBe('tache')
    view.destroy()
  })

  it('le curseur dans le marqueur montre le tiret brut', () => {
    const view = setup(DOC.indexOf('- alpha') + 1)
    const line = liveLine(view)
    expect(line.textContent).toBe('- alpha')
    expect(line.querySelector('.vault-list-marker-live')).toBeNull()
    view.destroy()
  })
})
