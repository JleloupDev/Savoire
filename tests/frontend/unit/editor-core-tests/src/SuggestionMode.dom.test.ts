// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Mode suggestion (suivi des modifications) : la frappe ne change pas le
// document, elle devient des propositions. Chaque test joue de vraies
// transactions d'editeur (frappe, effacement, remplacement de selection).
import { describe, it, expect, afterEach } from 'vitest'
import { EditorState, EditorSelection } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import {
  suggestionModeExtension, setSuggestionSink, flushSuggestion, pendingSuggestion, type TextProposal,
} from '../../../../../packages/editor-core/src/SuggestionMode'

const views: EditorView[] = []
afterEach(() => { for (const v of views.splice(0)) v.destroy() })

function editor(doc: string, opts: { suggesting?: boolean; dynamic?: () => boolean } = {}) {
  const proposals: { change: TextProposal; before: string }[] = []
  const sink = { propose: (change: TextProposal, read: (a: number, b: number) => string) => proposals.push({ change, before: read(change.from, change.to) }) }
  const view = new EditorView({
    parent: document.body,
    state: EditorState.create({ doc, extensions: [suggestionModeExtension(opts.dynamic ? () => (opts.dynamic!() ? sink : null) : undefined)] }),
  })
  views.push(view)
  if (opts.suggesting !== false && !opts.dynamic) setSuggestionSink(view, sink)
  const type = (text: string) => {
    for (const ch of text) {
      const at = view.state.selection.main
      view.dispatch({ changes: { from: at.from, to: at.to, insert: ch }, selection: { anchor: at.from + ch.length }, userEvent: 'input.type' })
    }
  }
  const backspace = (n = 1) => {
    for (let i = 0; i < n; i++) {
      const at = view.state.selection.main.head
      view.dispatch({ changes: { from: at - 1, to: at }, selection: { anchor: at - 1 }, userEvent: 'delete.backward' })
    }
  }
  const select = (from: number, to: number) => view.dispatch({ selection: EditorSelection.single(from, to) })
  return { view, proposals, type, backspace, select }
}

describe('mode suggestion', () => {
  it('taper ne change pas le document : un ajout propose, en attente, puis envoye', () => {
    const e = editor('Bonjour le monde')
    e.select(7, 7)
    e.type('cher ')
    expect(e.view.state.doc.toString()).toBe('Bonjour le monde')
    expect(pendingSuggestion(e.view.state)).toEqual({ from: 7, to: 7, insert: 'cher ' })
    flushSuggestion(e.view)
    expect(e.proposals).toEqual([{ change: { from: 7, to: 7, insert: 'cher ' }, before: '' }])
    expect(pendingSuggestion(e.view.state)).toBeNull()
  })

  it('remplacer une selection : le passage est barre, le texte tape le suit', () => {
    const e = editor('Bonjour le monde')
    e.select(11, 16)
    e.type('Savoire')
    flushSuggestion(e.view)
    expect(e.view.state.doc.toString()).toBe('Bonjour le monde')
    expect(e.proposals).toEqual([{ change: { from: 11, to: 16, insert: 'Savoire' }, before: 'monde' }])
  })

  it('effacer : retire d\'abord le texte propose, puis etend le passage barre', () => {
    const e = editor('abcdef')
    e.select(6, 6)
    e.type('XY')
    e.backspace(2)
    expect(pendingSuggestion(e.view.state)).toBeNull()
    e.backspace(3)
    flushSuggestion(e.view)
    expect(e.view.state.doc.toString()).toBe('abcdef')
    expect(e.proposals).toEqual([{ change: { from: 3, to: 6, insert: '' }, before: 'def' }])
  })

  it('taper ailleurs envoie la proposition en cours et en ouvre une autre', () => {
    const e = editor('un deux trois')
    e.select(2, 2)
    e.type('!')
    e.select(13, 13)
    e.type('?')
    flushSuggestion(e.view)
    expect(e.proposals.map(p => p.change)).toEqual([{ from: 2, to: 2, insert: '!' }, { from: 13, to: 13, insert: '?' }])
  })

  it('les modifications des autres membres passent et decalent la proposition en attente', () => {
    const e = editor('abc')
    e.select(3, 3)
    e.type('Z')
    e.view.dispatch({ changes: { from: 0, insert: '>> ' } }) // un autre membre (pas de userEvent)
    expect(e.view.state.doc.toString()).toBe('>> abc')
    expect(pendingSuggestion(e.view.state)).toEqual({ from: 6, to: 6, insert: 'Z' })
  })

  it('hors mode suggestion, on ecrit directement ; couper le mode envoie ce qui attend', () => {
    const e = editor('abc', { suggesting: false })
    e.select(3, 3)
    e.type('d')
    expect(e.view.state.doc.toString()).toBe('abcd')
    setSuggestionSink(e.view, { propose: () => {} })
    const sent: TextProposal[] = []
    setSuggestionSink(e.view, { propose: c => sent.push(c) })
    e.type('!')
    setSuggestionSink(e.view, null)
    expect(sent).toEqual([{ from: 4, to: 4, insert: '!' }])
    e.type('?')
    expect(e.view.state.doc.toString()).toBe('abcd?')
  })

  it('puits dynamique (editeurs des plugins) : suit le mode global', () => {
    let on = false
    const e = editor('abc', { dynamic: () => on })
    e.select(3, 3)
    e.type('d')
    expect(e.view.state.doc.toString()).toBe('abcd')
    on = true
    e.type('e')
    expect(e.view.state.doc.toString()).toBe('abcd')
    flushSuggestion(e.view)
    expect(e.proposals.map(p => p.change)).toEqual([{ from: 4, to: 4, insert: 'e' }])
  })
})
