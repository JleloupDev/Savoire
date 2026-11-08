// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// « + Nouvelle ligne » sous un tableau Markdown : une ligne vide a la fin,
// autant de cases que l'en-tete, curseur dans la premiere.
import { describe, it, expect } from 'vitest'
import { EditorState } from '@codemirror/state'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { appendTableRow, tableColumnCount } from '../../../../../packages/editor-core/src/TableRows'

function stateOf(doc: string) {
  const state = EditorState.create({ doc, extensions: [markdown({ base: markdownLanguage })] })
  return state
}

describe('appendTableRow', () => {
  it('compte les colonnes, avec ou sans barres au bord, barres echappees comprises', () => {
    expect(tableColumnCount('| A | B | C |')).toBe(3)
    expect(tableColumnCount('A | B')).toBe(2)
    expect(tableColumnCount('| a \\| b | c |')).toBe(2)
  })

  it('ajoute une ligne vide sous la derniere, curseur dans la premiere case', () => {
    const doc = 'Avant\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\nApres'
    const state = stateOf(doc)
    const tr = state.update(appendTableRow(state, doc.indexOf('| A'))!)
    expect(tr.state.doc.toString()).toBe('Avant\n\n| A | B |\n| - | - |\n| 1 | 2 |\n|   |   |\n\nApres')
    const head = tr.state.selection.main.head
    expect(tr.state.doc.lineAt(head).text).toBe('|   |   |')
    expect(head - tr.state.doc.lineAt(head).from).toBe(2)
  })

  it('tableau en fin de note, et position hors tableau', () => {
    const doc = '| A |\n| - |'
    const state = stateOf(doc)
    expect(state.update(appendTableRow(state, 0)!).state.doc.toString()).toBe('| A |\n| - |\n|   |')
    const prose = stateOf('Juste du texte')
    expect(appendTableRow(prose, 3)).toBeNull()
  })
})
