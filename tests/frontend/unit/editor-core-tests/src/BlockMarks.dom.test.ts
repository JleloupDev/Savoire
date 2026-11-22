// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Marques de blocs : trait sur les lignes du bloc, pastille qui s'ouvre sur
// un texte et des boutons, plusieurs sources independantes.
import { describe, it, expect, afterEach } from 'vitest'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { applyBlockMarks, blockMarksExtension } from '../../../../../packages/editor-core/src/BlockMarks'

const views: EditorView[] = []
afterEach(() => { for (const v of views.splice(0)) v.destroy() })

function editor(doc: string) {
  const view = new EditorView({ parent: document.body, state: EditorState.create({ doc, extensions: [blockMarksExtension()] }) })
  views.push(view)
  return view
}

const marked = (view: EditorView, cls: string) => [...view.dom.querySelectorAll(`.cm-line.${cls}`)].map(l => l.textContent)

describe('marques de blocs', () => {
  it('toutes les lignes du bloc ; chaque source remplace seulement les siennes', () => {
    const view = editor('Un\ndeux\n\nTrois')
    applyBlockMarks(view, 'visit', [{ from: 0, to: 6, className: 'cm-block-changed' }])
    applyBlockMarks(view, 'watch', [{ from: 9, to: 14, className: 'cm-block-watch-pending' }])
    expect(marked(view, 'cm-block-changed')).toEqual(['Un', 'deux'])
    expect(marked(view, 'cm-block-watch-pending')).toEqual(['Trois'])
    applyBlockMarks(view, 'visit', [])
    expect(marked(view, 'cm-block-changed')).toEqual([])
    expect(marked(view, 'cm-block-watch-pending')).toEqual(['Trois'])
  })

  it('les marques suivent le texte', () => {
    const view = editor('A\n\nB')
    applyBlockMarks(view, 'visit', [{ from: 3, to: 4, className: 'cm-block-changed' }])
    view.dispatch({ changes: { from: 0, insert: 'Avant\n\n' } })
    expect(marked(view, 'cm-block-changed')).toEqual(['B'])
  })

  it('pastille : s ouvre au clic, ses boutons agissent', () => {
    const view = editor('Un paragraphe.')
    let kept = 0
    applyBlockMarks(view, 'watch', [{
      from: 0, to: 14, className: 'cm-block-watch-advice',
      badge: { label: '💡', text: 'Développe cette idée.', actions: [{ label: 'Garder', run: () => { kept++ } }] },
    }])
    const button = view.dom.querySelector('.cm-block-badge-button') as HTMLButtonElement
    const panel = view.dom.querySelector('.cm-block-badge-panel') as HTMLElement
    expect(panel.hidden).toBe(true)
    button.click()
    expect(panel.hidden).toBe(false)
    expect(panel.textContent).toContain('Développe cette idée.')
    ;(view.dom.querySelector('.cm-block-badge-action') as HTMLButtonElement).click()
    expect(kept).toBe(1)
  })
})
