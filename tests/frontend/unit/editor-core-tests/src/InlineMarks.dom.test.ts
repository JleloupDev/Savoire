// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Sur la ligne du curseur, les marques (** _ ~~ ` == [](...)) ne se montrent
// que pour la mise en forme ou est le curseur.
import { describe, it, expect } from 'vitest'
import { EditorView } from '@codemirror/view'
import { EditorState, EditorSelection } from '@codemirror/state'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { createLivePreviewExtension, type PreviewMode } from '../../../../../packages/editor-core/src/LivePreview'

const LINE = 'un **gras** et *ital* et ~~barre~~ et `code` et [lien](http://x.fr) et ==surli=='

function setup(doc: string, cursor: number, mode: PreviewMode = 'power') {
  const parent = document.createElement('div')
  document.body.appendChild(parent)
  return new EditorView({
    parent,
    state: EditorState.create({
      doc, selection: EditorSelection.cursor(cursor),
      extensions: [markdown({ base: markdownLanguage }), ...createLivePreviewExtension(undefined, undefined, { editorView: null }, false, undefined, mode)],
    }),
  })
}

const rawLine = (view: EditorView) => view.contentDOM.querySelector('.cm-line')?.textContent

describe('Marques sur la ligne du curseur', () => {
  it.each(['power', 'classic'] as const)('mode %s : cachees hors de la mise en forme du curseur', mode => {
    const view = setup(LINE, 0, mode)
    expect(rawLine(view)).toBe('un gras et ital et barre et code et lien et surli')
    expect(view.contentDOM.querySelector('.plume-md-code')?.textContent).toBe('code')
    expect(view.contentDOM.querySelector('.plume-md-link')?.textContent).toBe('lien')
    // Dans le gras : ses ** seulement.
    view.dispatch({ selection: { anchor: LINE.indexOf('gras') + 2 } })
    expect(rawLine(view)).toBe('un **gras** et ital et barre et code et lien et surli')
    // Juste apres le lien : le lien entier.
    view.dispatch({ selection: { anchor: LINE.indexOf(' et ==') } })
    expect(rawLine(view)).toBe('un gras et ital et barre et code et [lien](http://x.fr) et surli')
    view.destroy()
  })

  it('une selection qui touche plusieurs mises en forme les montre toutes', () => {
    const view = setup(LINE, 0)
    view.dispatch({ selection: EditorSelection.range(LINE.indexOf('gras'), LINE.indexOf('ital')) })
    expect(rawLine(view)).toBe('un **gras** et *ital* et barre et code et lien et surli')
    view.destroy()
  })

  it('le code d\'un bloc de code garde tout', () => {
    const doc = '```\na **b** `c`\n```'
    const view = setup(doc, doc.indexOf('a'))
    expect(Array.from(view.contentDOM.querySelectorAll('.cm-line')).map(l => l.textContent)).toContain('a **b** `c`')
    view.destroy()
  })
})
