// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Commandes de Plume reprises d'Obsidian (memes identifiants), et la table
// des commandes d'Obsidian : chaque cible existe vraiment.
import { describe, it, expect } from 'vitest'
import { EditorView } from '@codemirror/view'
import { EditorState, EditorSelection } from '@codemirror/state'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import {
  alignTableColumn, copyTableColumn, copyTableRow, cycleListLine, tableCellAt, toggleWrap, withoutFrontmatter,
} from '../../../../../packages/editor-core/src/MoreCommands'
import { plumeCommands } from '../../../../../packages/editor-core/src/EditorCore'
import { OBSIDIAN_COMMANDS, obsidianCommandsWithout, savoireCommandFor } from '../../../../../packages/application/src/import/obsidian/obsidianCommands'

function view(doc: string, anchor: number, head = anchor) {
  const parent = document.createElement('div')
  document.body.appendChild(parent)
  return new EditorView({
    state: EditorState.create({ doc, selection: EditorSelection.single(anchor, head), extensions: [markdown({ base: markdownLanguage })] }),
    parent,
  })
}

const run = (id: string, v: EditorView) => {
  const cmd = plumeCommands().find(c => c.id === id)
  if (!cmd) throw new Error(`commande absente : ${id}`)
  return cmd.run({ editorView: v })
}

describe('texte', () => {
  it('entoure ou retire une marque, dedans comme autour', () => {
    expect(toggleWrap('a x b', 2, 3, '$')).toEqual({ text: 'a $x$ b', from: 3, to: 4 })
    expect(toggleWrap('a $x$ b', 3, 4, '$')).toEqual({ text: 'a x b', from: 2, to: 3 })
    expect(toggleWrap('a $x$ b', 2, 5, '$')).toEqual({ text: 'a x b', from: 2, to: 3 })
    expect(toggleWrap('a b', 2, 3, '%%').text).toBe('a %%b%%')
  })

  it('alterne texte, puce, case a cocher', () => {
    expect(cycleListLine('Acheter')).toBe('- Acheter')
    expect(cycleListLine('- Acheter')).toBe('- [ ] Acheter')
    expect(cycleListLine('  - [x] Acheter')).toBe('  Acheter')
  })

  it('retire le bloc de proprietes', () => {
    expect(withoutFrontmatter('---\na: 1\n---\nTexte\n')).toBe('Texte\n')
    expect(withoutFrontmatter('Texte')).toBe('Texte')
  })

  it('formule en ligne, bloc de formule, commentaire', () => {
    const v = view('aire x\n', 5, 6)
    run('editor:toggle-inline-math', v)
    expect(v.state.doc.toString()).toBe('aire $x$\n')
    const w = view('', 0)
    run('editor:insert-mathblock', w)
    expect(w.state.doc.toString()).toBe('$$\n\n$$\n')
    expect(w.state.selection.main.head).toBe(3)
    const c = view('secret', 0, 6)
    run('editor:toggle-comments', c)
    expect(c.state.doc.toString()).toBe('%%secret%%')
  })

  it('retire les proprietes et ajoute la propriete aliases', () => {
    const v = view('---\na: 1\n---\nTexte', 0)
    run('markdown:clear-metadata-properties', v)
    expect(v.state.doc.toString()).toBe('Texte')
    run('markdown:add-alias', v)
    expect(v.state.doc.toString()).toMatch(/^---\naliases: \[\]\n---\n/)
  })
})

describe('tableaux', () => {
  const T = '| A | B |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |'

  it('trouve la case du curseur', () => {
    expect(tableCellAt(T, T.indexOf('B'))).toEqual({ row: 0, col: 1 })
    expect(tableCellAt(T, T.indexOf('3'))).toEqual({ row: 2, col: 0 })
    expect(tableCellAt(T, T.indexOf('---'))).toEqual({ row: 0, col: 0 })
  })

  it('duplique une ligne, une colonne ; aligne une colonne', () => {
    expect(copyTableRow(T, 1)).toBe('| A | B |\n| --- | --- |\n| 1 | 2 |\n| 1 | 2 |\n| 3 | 4 |')
    expect(copyTableColumn(T, 0).split('\n')[0]).toBe('| A | A | B |')
    expect(alignTableColumn(T, 1, 'center').split('\n')[1]).toBe('| --- | :---: |')
    expect(alignTableColumn(alignTableColumn(T, 1, 'center'), 1, 'right').split('\n')[1]).toBe('| --- | ---: |')
  })

  it('les commandes agissent sur le tableau du curseur', () => {
    const doc = `Avant\n\n${T}\n`
    const v = view(doc, doc.indexOf('3'))
    run('editor:table-row-delete', v)
    expect(v.state.doc.toString()).toBe('Avant\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n')
    const w = view(doc, doc.indexOf('2'))
    run('editor:table-col-after', w)
    expect(w.state.doc.toString().split('\n')[2]).toBe('| A | B |  |')
  })
})

describe('commandes d\'Obsidian', () => {
  it('chaque commande de l\'editeur visee existe dans Plume', () => {
    const plume = new Set(plumeCommands().map(c => c.id))
    // Enregistrees ailleurs que dans Plume (plugins, application).
    const elsewhere = new Set(['editor:follow-link', 'editor:toggle-source', 'markdown:toggle-preview', 'footnotes:insert', 'editor:export-pdf', 'editor:present'])
    const targets = Object.keys(OBSIDIAN_COMMANDS).map(savoireCommandFor).filter((t): t is string => !!t && /^(editor|markdown):/.test(t))
    const missing = targets.filter(t => !plume.has(t) && !elsewhere.has(t))
    expect(missing).toEqual([])
  })

  it('dit pourquoi une commande n\'a pas d\'equivalent', () => {
    expect(savoireCommandFor('editor:toggle-bold')).toBe('editor:toggle-bold')
    expect(savoireCommandFor('command-palette:open')).toBe('app:command-palette')
    expect(savoireCommandFor('sync:setup')).toBeNull()
    expect(obsidianCommandsWithout('never').find(c => c.id === 'editor:save-file')?.why).toContain('automatique')
    expect(obsidianCommandsWithout('later').some(c => c.id === 'workspace:new-tab')).toBe(true)
  })
})
