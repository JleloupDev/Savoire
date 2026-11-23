// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Largeur des colonnes d'un tableau : ecrite dans la ligne des tirets (comme
// Pandoc), rendue en colonnes fixes, changee en tirant le bord d'une colonne.
import { describe, it, expect } from 'vitest'
import { EditorView } from '@codemirror/view'
import { EditorState, EditorSelection } from '@codemirror/state'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { createLivePreviewExtension, type PreviewMode } from '../../../../../packages/editor-core/src/LivePreview'
import { tableWidthsIn, withTableWidths, withoutTableWidths } from '../../../../../packages/editor-core/src/TableWidths'
import { insertTableColumn } from '../../../../../packages/editor-core/src/TableRows'
import { renderFragmentInto } from '../../../../../packages/editor-core/src/NoteFragment'

const T = '| a | b | c |\n|:---|---|---:|\n| 1 | 2 | 3 |'
const WIDE = '| a | b |\n|----------|------------------------------|\n| 1 | 2 |'

function setup(doc: string, mode: PreviewMode) {
  const parent = document.createElement('div')
  document.body.appendChild(parent)
  return new EditorView({
    parent,
    state: EditorState.create({
      doc: `${doc}\n\nfin`,
      selection: EditorSelection.cursor(doc.length + 5),
      extensions: [markdown({ base: markdownLanguage }), ...createLivePreviewExtension(undefined, undefined, { editorView: null }, false, undefined, mode)],
    }),
  })
}

const widthsShown = (root: Element) =>
  Array.from(root.querySelectorAll('colgroup.plume-table-cols col')).map(c => (c as HTMLElement).style.width)

describe('Largeur des colonnes d\'un tableau', () => {
  it('des tirets egaux : pas de largeur ; inegaux : leurs parts', () => {
    expect(tableWidthsIn(T)).toEqual([null])
    expect(tableWidthsIn(WIDE)).toEqual([[25, 75]])
    // Dans un callout aussi.
    expect(tableWidthsIn('> [!NOTE]\n> | a | b |\n> |---|---------|')).toEqual([[25, 75]])
  })

  it('ecrire des largeurs garde les alignements ; les retirer aussi', () => {
    const out = withTableWidths(T, [50, 25, 25])
    expect(out.split('\n')[1]).toBe('| :-------------------- | ---------- | ----------: |')
    expect(tableWidthsIn(out)).toEqual([[50, 25, 25]])
    expect(withoutTableWidths(out).split('\n')[1]).toBe('| :--- | --- | ---: |')
  })

  it('une colonne ajoutee prend la largeur moyenne', () => {
    expect(insertTableColumn(WIDE, 1, true).split('\n')[1]).toBe('| ---------- | ------------------------------ | -------------------- |')
  })

  it.each(['power', 'classic'] as const)('mode %s : le tableau rendu a ses largeurs et ses poignees', mode => {
    const view = setup(WIDE, mode)
    expect(widthsShown(view.contentDOM)).toEqual(['25%', '75%'])
    expect(view.contentDOM.querySelectorAll('[data-testid="table-resizer"]')).toHaveLength(1)
    // Double clic sur la poignee : largeurs automatiques.
    view.contentDOM.querySelector('[data-testid="table-resizer"]')!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }))
    expect(view.state.doc.toString()).toBe('| a | b |\n| --- | --- |\n| 1 | 2 |\n\nfin')
    expect(widthsShown(view.contentDOM)).toEqual([])
    view.destroy()
  })

  it('a l\'export et dans un callout : memes largeurs', () => {
    const root = document.createElement('div')
    renderFragmentInto(root, `intro\n\n${WIDE}`, {})
    expect(widthsShown(root)).toEqual(['25%', '75%'])
  })
})
