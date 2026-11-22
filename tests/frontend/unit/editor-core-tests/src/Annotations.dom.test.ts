// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Cartes de revision dans la note : un passage surligne s'ouvre dans une
// carte dessinee par l'hote ; Echap la ferme ; un brouillon s'ouvre sur la
// selection ; un editeur de plugin recoit ses passages d'une source.
import { describe, it, expect, afterEach } from 'vitest'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { applyHighlights, highlightIdsAt, highlightsExtension } from '../../../../../packages/editor-core/src/Highlights'
import {
  annotationsExtension, closeAnnotations, openAnnotationDraft, openAnnotations, openedAnnotation,
  reviewOverlayExtension, setAnnotationHost, type AnnotationHost,
} from '../../../../../packages/editor-core/src/Annotations'

const views: EditorView[] = []
afterEach(() => { for (const v of views.splice(0)) v.destroy() })

function recordingHost() {
  const rendered: string[][] = []
  const drafts: { kind: string; from: number; to: number }[] = []
  let cleaned = 0
  const host: AnnotationHost = {
    render(ids, dom) { rendered.push(ids); dom.textContent = `fils ${ids.join(',')}`; return () => { cleaned++ } },
    renderDraft(draft, dom) { drafts.push(draft); dom.textContent = 'brouillon'; return () => { cleaned++ } },
  }
  return { host, rendered, drafts, cleaned: () => cleaned }
}

function editor(doc: string, host?: AnnotationHost) {
  const view = new EditorView({
    parent: document.body,
    state: EditorState.create({ doc, extensions: [highlightsExtension(), annotationsExtension(host)] }),
  })
  views.push(view)
  return view
}

const card = (view: EditorView) => view.dom.querySelector('[data-testid="annotation-card"]')

describe('Annotations dans la note', () => {
  it('les passages surlignes se retrouvent par position, le plus precis d\'abord', () => {
    const view = editor('un deux trois quatre')
    applyHighlights(view, [
      { from: 0, to: 13, className: 'review-mark', id: 'large' },
      { from: 3, to: 7, className: 'review-mark', id: 'precis' },
    ])
    expect(highlightIdsAt(view.state, 5)).toEqual(['precis', 'large'])
    expect(highlightIdsAt(view.state, 16)).toEqual([])
  })

  it('une suggestion d\'ajout (plage vide) se retrouve a sa position', () => {
    const view = editor('abc')
    applyHighlights(view, [{ from: 1, to: 1, className: 'review-mark', id: 's1', insert: 'X' }])
    expect(highlightIdsAt(view.state, 1)).toEqual(['s1'])
  })

  it('ouvre la carte des fils avec l\'hote, Echap la ferme', () => {
    const { host, rendered, cleaned } = recordingHost()
    const view = editor('un deux trois', host)
    openAnnotations(view, ['c1'], 3)
    expect(openedAnnotation(view.state)).toEqual({ ids: ['c1'] })
    expect(rendered).toEqual([['c1']])
    expect(card(view)?.textContent).toBe('fils c1')
    card(view)!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(openedAnnotation(view.state)).toBeNull()
    expect(card(view)).toBeNull()
    expect(cleaned()).toBe(1)
  })

  it('la carte reste ouverte (et n\'est pas redessinee) quand le texte change', () => {
    const { host, rendered } = recordingHost()
    const view = editor('un deux trois', host)
    openAnnotations(view, ['c1'], 3)
    view.dispatch({ changes: { from: 0, insert: 'zero ' } })
    expect(openedAnnotation(view.state)).toEqual({ ids: ['c1'] })
    expect(rendered).toHaveLength(1)
  })

  it('sans hote, rien ne s\'ouvre', () => {
    const view = editor('un deux trois')
    openAnnotations(view, ['c1'], 3)
    expect(openedAnnotation(view.state)).toBeNull()
    expect(openAnnotationDraft(view, { kind: 'comment', from: 0, to: 2 })).toBe(false)
  })

  it('un hote pose apres coup ouvre les cartes ; le retirer les ferme', () => {
    const { host } = recordingHost()
    const view = editor('un deux trois')
    setAnnotationHost(view, host)
    openAnnotations(view, ['c1'], 3)
    expect(card(view)).not.toBeNull()
    setAnnotationHost(view, null)
    expect(openedAnnotation(view.state)).toBeNull()
  })

  it('ouvre un brouillon sur la selection', () => {
    const { host, drafts } = recordingHost()
    const view = editor('un deux trois', host)
    expect(openAnnotationDraft(view, { kind: 'suggestion', from: 3, to: 7 })).toBe(true)
    expect(drafts).toEqual([{ kind: 'suggestion', from: 3, to: 7 }])
    expect(card(view)?.textContent).toBe('brouillon')
    closeAnnotations(view)
    expect(card(view)).toBeNull()
  })

  it('les touches tapees dans la carte ne vont pas a l\'editeur', () => {
    const { host } = recordingHost()
    const view = editor('abc', host)
    openAnnotations(view, ['c1'], 1)
    let reached = false
    view.dom.addEventListener('keydown', () => { reached = true })
    card(view)!.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }))
    expect(reached).toBe(false)
  })

  it('editeur de plugin : les passages viennent de la source, et suivent ses changements', async () => {
    const { host } = recordingHost()
    let notify: () => void = () => {}
    let ranges = [{ from: 0, to: 2, className: 'review-mark', id: 'a' }]
    const view = new EditorView({
      parent: document.body,
      state: EditorState.create({
        doc: 'un deux',
        extensions: [reviewOverlayExtension(host, { ranges: () => ranges, subscribe: cb => { notify = cb; return () => {} } })],
      }),
    })
    views.push(view)
    await Promise.resolve()
    expect(highlightIdsAt(view.state, 1)).toEqual(['a'])
    ranges = [{ from: 3, to: 7, className: 'review-mark', id: 'b' }]
    notify()
    await Promise.resolve()
    expect(highlightIdsAt(view.state, 1)).toEqual([])
    expect(highlightIdsAt(view.state, 5)).toEqual(['b'])
  })
})
