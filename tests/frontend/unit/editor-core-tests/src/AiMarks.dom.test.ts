// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Marques pour l'IA : des decorations (surlignage, epingle), jamais dans le
// texte de la note ; elles suivent les modifications.
import { describe, it, expect, afterEach } from 'vitest'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { aiMarkRanges, aiMarksExtension, applyAiMarks, renderedNeedle } from '../../../../../packages/editor-core/src/AiMarks'

const views: EditorView[] = []
afterEach(() => { for (const v of views.splice(0)) v.destroy() })

function editor(doc: string) {
  const view = new EditorView({ parent: document.body, state: EditorState.create({ doc, extensions: [aiMarksExtension()] }) })
  views.push(view)
  return view
}

const texts = (view: EditorView, selector: string) => Array.from(view.dom.querySelectorAll(selector)).map(e => e.textContent)

describe('marques pour l IA', () => {
  it('un passage surligne et une epingle sont dessines, sans toucher au texte', () => {
    const doc = 'Un passage a reformuler.\nUne conclusion.'
    const view = editor(doc)
    applyAiMarks(view, [
      { id: 'h1', from: 3, to: 10, kind: 'highlight', title: 'Passage surligné pour l’IA' },
      { id: 'p1', from: 29, to: 39, kind: 'pin', title: 'Épingle : Conclusion' },
    ])
    expect(texts(view, '.cm-ai-highlight')).toEqual(['passage'])
    expect(texts(view, '.cm-ai-pin')).toEqual(['conclusion'])
    const mark = view.dom.querySelector('.cm-ai-highlight') as HTMLElement
    expect(mark.getAttribute('data-ai-mark')).toBe('h1')
    expect(mark.title).toBe('Passage surligné pour l’IA')
    expect(view.state.doc.toString()).toBe(doc)
    // Effacer : plus rien.
    applyAiMarks(view, [])
    expect(texts(view, '.cm-ai-highlight, .cm-ai-pin')).toEqual([])
    expect(aiMarkRanges(view.state)).toEqual([])
    expect(view.state.doc.toString()).toBe(doc)
  })

  it('une epingle sur un simple endroit : un repere, pas de texte ajoute a la note', () => {
    const view = editor('Avant apres')
    applyAiMarks(view, [{ id: 'p', from: 6, to: 6, kind: 'pin', title: 'Ici' }])
    const point = view.dom.querySelector('.cm-ai-pin-point') as HTMLElement
    expect(point?.dataset.aiMark).toBe('p')
    expect(view.state.doc.toString()).toBe('Avant apres')
  })

  it('les marques suivent le texte ; ce qu on ecrit a leurs bords n y entre pas', () => {
    const view = editor('Le chat dort.')
    applyAiMarks(view, [{ id: 'h', from: 3, to: 7, kind: 'highlight' }])
    view.dispatch({ changes: { from: 0, insert: 'Ce matin, ' } })
    expect(aiMarkRanges(view.state)).toMatchObject([{ id: 'h', from: 13, to: 17 }])
    view.dispatch({ changes: { from: 13, insert: 'gros ' } })
    view.dispatch({ changes: { from: 22, insert: ' noir' } })
    expect(texts(view, '.cm-ai-highlight')).toEqual(['chat'])
    // Le passage est supprime : la marque se replie, sans erreur.
    const at = aiMarkRanges(view.state)[0]
    view.dispatch({ changes: { from: at.from - 2, to: at.to + 2 } })
    expect(aiMarkRanges(view.state)[0].to).toBe(aiMarkRanges(view.state)[0].from)
  })

  it('des bornes hors du texte sont ramenees dedans', () => {
    const view = editor('court')
    applyAiMarks(view, [{ id: 'h', from: -4, to: 999, kind: 'highlight' }])
    expect(aiMarkRanges(view.state)).toMatchObject([{ from: 0, to: 5 }])
    expect(texts(view, '.cm-ai-highlight')).toEqual(['court'])
  })

  it('le texte cherche dans le rendu : la ligne sans ses marques Markdown', () => {
    expect(renderedNeedle('## Un titre')).toBe('Un titre')
    expect(renderedNeedle('- [ ] une tâche **importante**')).toBe('une tâche importante')
    expect(renderedNeedle('3. troisième point')).toBe('troisième point')
    expect(renderedNeedle('> une citation en *italique*')).toBe('une citation en italique')
    expect(renderedNeedle('voir [[Projets/Plan|le plan]] et [le site](https://exemple.org)')).toBe('voir le plan et le site')
    expect(renderedNeedle('du `code` et snake_case')).toBe('du code et snake_case')
    expect(renderedNeedle('   ')).toBe('')
  })
})
