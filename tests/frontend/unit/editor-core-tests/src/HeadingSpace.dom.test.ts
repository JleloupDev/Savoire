// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Espace avant les titres (theme : --plume-hN-before) : un bloc a part
// avant la ligne du titre, le meme que le titre soit rendu ou en edition.
import { describe, it, expect } from 'vitest'
import { EditorView } from '@codemirror/view'
import { EditorState, EditorSelection } from '@codemirror/state'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { createLivePreviewExtension, type PreviewMode } from '../../../../../packages/editor-core/src/LivePreview'

function setup(doc: string, cursor = 0, mode: PreviewMode = 'power') {
  const parent = document.createElement('div')
  document.body.appendChild(parent)
  return new EditorView({
    parent,
    state: EditorState.create({
      doc,
      selection: EditorSelection.cursor(cursor),
      extensions: [markdown({ base: markdownLanguage }), ...createLivePreviewExtension(undefined, undefined, { editorView: null }, false, undefined, mode)],
    }),
  })
}

const spaces = (view: EditorView) => Array.from(view.contentDOM.querySelectorAll('.plume-heading-space')).map(e => e.className.replace('plume-heading-space ', ''))

describe('Espace avant les titres', () => {
  it('avant chaque titre, sauf le premier bloc de la note', () => {
    const view = setup('# Un\n\ntexte\n\n## Deux\n\nAutre\n===\n\n#### Quatre')
    expect(spaces(view)).toEqual(['plume-heading-space-h2', 'plume-heading-space-h1', 'plume-heading-space-h4'])
    view.destroy()
  })

  it('le meme, que le titre soit en edition ou rendu', () => {
    for (const mode of ['power', 'classic'] as const) {
      const doc = 'texte\n\n## Deux\n\nfin'
      const view = setup(doc, doc.indexOf('Deux'), mode)
      expect(spaces(view)).toEqual(['plume-heading-space-h2'])
      view.dispatch({ selection: { anchor: doc.length } })
      expect(spaces(view)).toEqual(['plume-heading-space-h2'])
      view.destroy()
    }
  })

  it("l'en-tete YAML ne compte pas, ni un titre dans une citation", () => {
    const view = setup('---\ntitre: x\n---\n# Premier\n\n> ## dans la citation\n\nfin')
    expect(spaces(view)).toEqual([])
    view.destroy()
  })
})
