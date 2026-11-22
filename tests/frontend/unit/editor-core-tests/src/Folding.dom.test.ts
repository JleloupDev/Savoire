// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Plume : replier un titre (jusqu'au titre suivant de meme niveau) ou un
// element de liste (ses lignes suivantes). Le curseur ne se perd pas dans
// ce qui est cache, et les blocs replies d'une note sont retenus.
import { describe, it, expect, beforeEach } from 'vitest'
import { EditorView } from '@codemirror/view'
import { EditorState, EditorSelection } from '@codemirror/state'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { createLivePreviewExtension } from '../../../../../packages/editor-core/src/LivePreview'
import {
  computeFoldables, foldAllHeadings, foldStorage, hiddenRanges, skipFold, toggleFold, toggleFoldAtCursor, unfoldAll,
} from '../../../../../packages/editor-core/src/Folding'

const DOC = [
  '# Un', '', 'texte un', '', '## Un.un', '', 'texte deux', '',
  '- parent', '  - enfant', '- seul', '', '# Deux', '', 'fin',
].join('\n')

const lineFrom = (state: EditorState, n: number) => state.doc.line(n).from

function setup(doc = DOC, key: string | null = null, cursor = doc.length) {
  const parent = document.createElement('div')
  document.body.appendChild(parent)
  return new EditorView({
    parent,
    state: EditorState.create({
      doc,
      selection: EditorSelection.cursor(cursor),
      extensions: [markdown({ base: markdownLanguage }), foldStorage.of(key), ...createLivePreviewExtension(undefined, undefined, { editorView: null }, false)],
    }),
  })
}

const shownText = (view: EditorView) => view.contentDOM.textContent ?? ''

beforeEach(() => localStorage.clear())

describe('Blocs repliables', () => {
  it('un titre va jusqu\'au titre suivant de meme niveau ; un element de liste, jusqu\'a ses enfants', () => {
    const state = EditorState.create({ doc: DOC, extensions: [markdown({ base: markdownLanguage })] })
    const { list } = computeFoldables(state)
    const show = list.map(f => `${f.kind} L${state.doc.lineAt(f.anchor).number}: L${state.doc.lineAt(f.from).number}-L${state.doc.lineAt(f.to).number}`)
    expect(show).toEqual([
      'heading L1: L2-L11',
      'heading L5: L6-L11',
      'list L9: L10-L10',
      'heading L13: L14-L15',
    ])
  })

  it('un titre sans contenu ni un titre dans des colonnes ne se replient pas', () => {
    const doc = '# Vide\n# Plein\n\ntexte\n\n::: colonnes\n## Dedans\n\nx\n+++\ny\n:::'
    const state = EditorState.create({ doc, extensions: [markdown({ base: markdownLanguage })] })
    const anchors = computeFoldables(state).list.map(f => state.doc.lineAt(f.anchor).text)
    expect(anchors).toEqual(['# Plein'])
  })
})

describe('Replier et deplier', () => {
  it('replier un titre cache sa section, « … » sur sa ligne ; deplier la rend', () => {
    const view = setup()
    expect(toggleFold(view, lineFrom(view.state, 1))).toBe(true)
    expect(shownText(view)).not.toContain('texte un')
    expect(shownText(view)).not.toContain('enfant')
    expect(shownText(view)).toContain('Deux')
    expect(view.contentDOM.querySelector('.plume-folded h1')?.textContent).toBe('Un')
    toggleFold(view, lineFrom(view.state, 1))
    expect(shownText(view)).toContain('texte un')
    view.destroy()
  })

  it('le curseur qui etait dans la section remonte sur le titre', () => {
    const view = setup(DOC, null, DOC.indexOf('texte deux'))
    toggleFold(view, lineFrom(view.state, 5))
    expect(view.state.doc.lineAt(view.state.selection.main.head).number).toBe(5)
    expect(hiddenRanges(view.state)).toHaveLength(1)
    view.destroy()
  })

  it('le curseur pose dans ce qui est cache (recherche, lien) ouvre le bloc', () => {
    const view = setup()
    toggleFold(view, lineFrom(view.state, 1))
    view.dispatch({ selection: EditorSelection.cursor(DOC.indexOf('texte un')) })
    expect(hiddenRanges(view.state)).toHaveLength(0)
    view.destroy()
  })

  it('les fleches sautent un bloc replie sans l\'ouvrir', () => {
    const view = setup()
    toggleFold(view, lineFrom(view.state, 1))
    view.dispatch({ selection: EditorSelection.cursor(view.state.doc.line(1).to) })
    expect(skipFold(view, 1)).toBe(true)
    expect(view.state.doc.lineAt(view.state.selection.main.head).number).toBe(12)
    expect(skipFold(view, -1)).toBe(true)
    expect(view.state.selection.main.head).toBe(view.state.doc.line(1).to)
    expect(hiddenRanges(view.state)).toHaveLength(1)
    view.destroy()
  })

  it('commandes : le bloc du curseur, tous les titres, tout deplier', () => {
    const view = setup(DOC, null, DOC.indexOf('enfant'))
    // Sur la ligne d'un enfant : l'element de liste qui le contient.
    toggleFoldAtCursor(view)
    expect(hiddenRanges(view.state).map(f => view.state.doc.lineAt(f.anchor).number)).toEqual([9])
    foldAllHeadings(view)
    expect(hiddenRanges(view.state).map(f => view.state.doc.lineAt(f.anchor).number)).toEqual([1, 13])
    unfoldAll(view)
    expect(hiddenRanges(view.state)).toHaveLength(0)
    view.destroy()
  })
})

describe('Memoire des blocs replies', () => {
  it('rouverte, la note garde ses blocs replies, meme si son texte arrive apres (synchro)', async () => {
    const first = setup(DOC, 'note-1')
    toggleFold(first, lineFrom(first.state, 5))
    await new Promise(r => setTimeout(r, 10))
    first.destroy()
    expect(JSON.parse(localStorage.getItem('plume:folds:note-1')!)).toEqual(['0|heading|## Un.un'])

    // Le texte arrive par la synchro, apres la creation de l'editeur.
    const second = setup('', 'note-1', 0)
    expect(hiddenRanges(second.state)).toHaveLength(0)
    second.dispatch({ changes: { from: 0, insert: DOC } })
    expect(hiddenRanges(second.state).map(f => second.state.doc.lineAt(f.anchor).text)).toEqual(['## Un.un'])
    second.destroy()
  })

  it('tout deplie : la note n\'a plus rien de retenu', async () => {
    const view = setup(DOC, 'note-2')
    toggleFold(view, lineFrom(view.state, 1))
    await new Promise(r => setTimeout(r, 10))
    unfoldAll(view)
    await new Promise(r => setTimeout(r, 10))
    expect(localStorage.getItem('plume:folds:note-2')).toBeNull()
    view.destroy()
  })
})
