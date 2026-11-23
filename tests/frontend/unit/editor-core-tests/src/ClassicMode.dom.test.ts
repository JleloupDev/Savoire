// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Mode classique de Plume (ADR-030) : les blocs restent des objets sous le
// curseur, « Modifier la source » les ouvre en texte, un plugin peut les
// modifier sans passer par le texte brut.
import { describe, it, expect } from 'vitest'
import { EditorView } from '@codemirror/view'
import { EditorState, EditorSelection, type Extension } from '@codemirror/state'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { createLivePreviewExtension, type PreviewMode } from '../../../../../packages/editor-core/src/LivePreview'
import { openSource } from '../../../../../packages/editor-core/src/ClassicMode'
import { createSubEditor, subEditorExtensions } from '../../../../../packages/editor-core/src/SubEditor'
import { brackets } from '../../../../../packages/editor-core/src/EditingAids'
import type { BlockEditContext, BlockRegistry, BlockSpec } from '@savoire/plugin-api'

const DOC = 'avant\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\n```demo\nx\n```\n\n::: colonnes\ngauche\n+++\ndroite\n:::\n\napres'

let lastEdit: BlockEditContext | null = null

function setup(mode: PreviewMode, doc = DOC, extra: Extension[] = []) {
  const spec: BlockSpec = {
    type: 'demo',
    detect: text => text.startsWith('```demo'),
    serialize: d => String(d),
    deserialize: raw => raw,
    createEditorWidget: () => ({ mount: () => {}, destroy: () => {} }),
    renderClient: () => { const el = document.createElement('div'); el.className = 'demo-block'; return el },
    renderEditable: (_data, ctx) => {
      lastEdit = ctx
      const el = document.createElement('div')
      el.className = 'demo-editable'
      return el
    },
  }
  const registry: BlockRegistry = {
    register: () => {}, unregister: () => {}, getAll: () => [spec],
    detectBlock: text => (spec.detect as (t: string) => boolean)(text) ? { type: 'demo', spec } : null,
  }
  const parent = document.createElement('div')
  document.body.appendChild(parent)
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc,
      selection: EditorSelection.cursor(0),
      extensions: [markdown({ base: markdownLanguage }), ...createLivePreviewExtension(registry, undefined, { editorView: null }, false, undefined, mode), ...extra],
    }),
  })
  return view
}

/** Ce qu'on tape dans un editeur, comme le ferait le navigateur. */
function type(view: EditorView, text: string) {
  const { from, to } = view.state.selection.main
  const done = view.state.facet(EditorView.inputHandler).some(h => h(view, from, to, text, () => view.state.update({ changes: { from, to, insert: text } })))
  if (!done) view.dispatch({ changes: { from, to, insert: text }, selection: { anchor: from + text.length }, userEvent: 'input.type' })
}

/** La case ouverte : son sous-editeur. */
const openCell = (view: EditorView, row: number, col: number): EditorView => {
  const cell = view.dom.querySelector(`td[data-row="${row}"][data-col="${col}"], th[data-row="${row}"][data-col="${col}"]`) as HTMLElement
  cell.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }))
  const sub = EditorView.findFromDOM(cell.querySelector('.cm-editor') as HTMLElement)
  expect(sub).not.toBeNull()
  return sub!
}

const tables = (view: EditorView) => view.dom.querySelectorAll('table').length

describe('Mode classique', () => {
  it('le tableau reste rendu quand le curseur y entre (pas en mode power)', () => {
    const power = setup('power')
    power.dispatch({ selection: EditorSelection.cursor(power.state.doc.toString().indexOf('| 1'))})
    expect(tables(power)).toBe(0)
    power.destroy()

    const classic = setup('classic')
    classic.dispatch({ selection: EditorSelection.cursor(classic.state.doc.toString().indexOf('| 1'))})
    expect(tables(classic)).toBe(1)
    classic.destroy()
  })

  it('les colonnes sont rendues en colonnes', () => {
    const view = setup('classic')
    const cols = view.dom.querySelectorAll('.plume-columns .plume-column')
    expect(cols).toHaveLength(2)
    expect(cols[0].textContent).toContain('gauche')
    expect(cols[1].textContent).toContain('droite')
    view.destroy()
  })

  it('« Modifier la source » ouvre le bloc en texte, comme du code, jusqu\'a ce que le curseur en sorte', () => {
    const view = setup('classic')
    const from = view.state.doc.toString().indexOf('| a')
    const to = view.state.doc.toString().indexOf('| 2 |') + 5
    openSource(view, { from, to })
    expect(tables(view)).toBe(0)
    expect(view.dom.querySelectorAll('.plume-source-line')).toHaveLength(3)
    view.dispatch({ selection: EditorSelection.cursor(0) })
    expect(tables(view)).toBe(1)
    expect(view.dom.querySelectorAll('.plume-source-line')).toHaveLength(0)
    view.destroy()
  })

  it('un plugin modifie son bloc par son rendu modifiable', () => {
    lastEdit = null
    const view = setup('classic')
    expect(view.dom.querySelector('.demo-editable')).not.toBeNull()
    expect(lastEdit!.source()).toBe('```demo\nx\n```')
    lastEdit!.replace('```demo\ny\n```')
    expect(view.state.doc.toString()).toContain('```demo\ny\n```')
    view.destroy()
  })

  it('une case de tableau s\'edite sur place, dans un sous-editeur', () => {
    const view = setup('classic')
    const sub = openCell(view, 1, 1)
    expect(sub.state.doc.toString()).toBe('2')
    // Chaque frappe part dans la note.
    sub.dispatch({ changes: { from: 0, to: 1, insert: 'deux' }, userEvent: 'input.type' })
    expect(view.state.doc.toString()).toContain('| 1 | deux |')
    // Un retour a la ligne colle devient une espace : la case reste sur sa ligne.
    sub.dispatch({ changes: { from: 4, insert: '\net trois' }, userEvent: 'input.paste' })
    expect(view.state.doc.toString()).toContain('| 1 | deux et trois |')
    sub.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    expect(view.state.doc.toString()).toContain('| 1 | deux et trois |\n|  |  |')
    view.destroy()
  })

  it('Echap rend a la case son texte d\'avant', () => {
    const view = setup('classic')
    const sub = openCell(view, 1, 0)
    sub.dispatch({ changes: { from: 0, to: 1, insert: 'un' }, userEvent: 'input.type' })
    expect(view.state.doc.toString()).toContain('| un | 2 |')
    sub.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    expect(view.state.doc.toString()).toContain('| 1 | 2 |')
    view.destroy()
  })

  it('les aides de la note valent dans un sous-editeur : == entoure le texte selectionne', () => {
    const host = setup('classic', DOC, [subEditorExtensions.of([brackets])])
    const parent = document.createElement('div')
    document.body.appendChild(parent)
    const sub = createSubEditor(host, parent, { doc: '2', singleLine: true })
    sub.dispatch({ selection: { anchor: 0, head: 1 } })
    type(sub, '=')
    type(sub, '=')
    expect(sub.state.doc.toString()).toBe('==2==')
    sub.destroy()
    host.destroy()
  })

  it('dans la case, les ** du gras se cachent hors du curseur, comme dans la note', () => {
    const view = setup('classic', '| a |\n| --- |\n| **gras** fin |\n\napres')
    const sub = openCell(view, 1, 0)
    expect(sub.contentDOM.textContent).toBe('gras fin')
    sub.dispatch({ selection: { anchor: 3 } })
    expect(sub.contentDOM.textContent).toBe('**gras** fin')
    view.destroy()
  })

  it('ecrire juste apres un objet ouvre une nouvelle ligne', () => {
    const view = setup('classic', '| a | b |\n| --- | --- |\n| 1 | 2 |')
    const end = view.state.doc.length
    view.dispatch({ selection: EditorSelection.cursor(end) })
    const handled = view.state.facet(EditorView.inputHandler).some(h => h(view, end, end, 'z', () => view.state.update({ changes: { from: end, insert: 'z' } })))
    expect(handled).toBe(true)
    expect(view.state.doc.toString()).toBe('| a | b |\n| --- | --- |\n| 1 | 2 |\nz')
    view.destroy()
  })

  it('cache les # du titre sous le curseur, et Retour arriere au debut le rend texte', () => {
    const view = setup('classic', 'intro\n## Mon titre')
    const start = view.state.doc.toString().indexOf('Mon')
    view.dispatch({ selection: EditorSelection.cursor(start) })
    const line = Array.from(view.dom.querySelectorAll('.cm-line')).find(l => l.textContent?.includes('Mon titre'))!
    expect(line.textContent).toBe('Mon titre')
    expect(view.state.doc.toString()).toBe('intro\n## Mon titre')
    view.destroy()
  })
})

