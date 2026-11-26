// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Plume au clavier : les fleches entrent dans un callout (titre, puis corps)
// et dans un tableau (case par case), et en ressortent. Un tableau change de
// lignes et de colonnes. Ecrire sous un callout ou un tableau ne s'y ajoute pas.
import { describe, it, expect } from 'vitest'
import { EditorView, runScopeHandlers } from '@codemirror/view'
import { EditorState, EditorSelection } from '@codemirror/state'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { createLivePreviewExtension, type PreviewMode } from '../../../../../packages/editor-core/src/LivePreview'
import {
  deleteTableColumn, deleteTableRow, insertTableColumn, insertTableRow, moveTableColumn, moveTableRow,
} from '../../../../../packages/editor-core/src/TableRows'
import calloutPlugin from '../../../../../packages/plugins/plugin-callout/src/index'
import type { BlockRegistry, BlockSpec, PluginAPI } from '@savoire/plugin-api'

function registryOf(...specs: BlockSpec[]): BlockRegistry {
  const match = (text: string) => specs.find(s => (typeof s.detect === 'function' ? s.detect(text) : !!s.detect?.test(text)))
  return {
    register: () => {}, unregister: () => {}, getAll: () => specs,
    detectBlock: text => { const spec = match(text); return spec ? { type: spec.type, spec } : null },
  }
}

async function calloutRegistry(): Promise<BlockRegistry> {
  let spec: BlockSpec | null = null
  const api = { triggers: { register: () => {} }, blocks: { register: (s: BlockSpec) => { spec = s } } } as unknown as PluginAPI
  await calloutPlugin.onload(api)
  return registryOf(spec!)
}

function setup(doc: string, cursor: number, mode: PreviewMode, registry?: BlockRegistry) {
  const parent = document.createElement('div')
  document.body.appendChild(parent)
  return new EditorView({
    parent,
    state: EditorState.create({
      doc,
      selection: EditorSelection.cursor(cursor),
      extensions: [markdown({ base: markdownLanguage }), ...createLivePreviewExtension(registry, undefined, { editorView: null }, false, undefined, mode)],
    }),
  })
}

/** Une touche dans la note (les raccourcis de CodeMirror). */
const noteKey = (view: EditorView, key: string) =>
  runScopeHandlers(view, new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }), 'editor')

/** Une touche dans l'element qui a le focus (titre, corps, case). */
const fieldKey = (key: string, opts: KeyboardEventInit = {}) =>
  document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...opts }))

/** Ce qu'on tape, comme le ferait le navigateur. */
function type(view: EditorView, text: string) {
  const { from, to } = view.state.selection.main
  const done = view.state.facet(EditorView.inputHandler).some(h => h(view, from, to, text, () => view.state.update({ changes: { from, to, insert: text } })))
  if (!done) view.dispatch({ changes: { from, to, insert: text }, selection: { anchor: from + text.length } })
}

const lineOf = (view: EditorView) => view.state.doc.lineAt(view.state.selection.main.head).number

describe('Tableau : lignes et colonnes', () => {
  const T = '| a | b |\n|---|:-:|\n| 1 | 2 |\n| 3 | 4 |'

  it('inserer et supprimer', () => {
    expect(insertTableRow(T, 1, false)).toBe('| a | b |\n| --- | :-: |\n|  |  |\n| 1 | 2 |\n| 3 | 4 |')
    expect(insertTableRow(T, 0, true).split('\n')[2]).toBe('|  |  |')
    expect(insertTableRow(T, 0, false)).toBe(T)
    expect(insertTableColumn(T, 0, true)).toBe('| a |  | b |\n| --- | --- | :-: |\n| 1 |  | 2 |\n| 3 |  | 4 |')
    expect(deleteTableRow(T, 2)).toBe('| a | b |\n| --- | :-: |\n| 1 | 2 |')
    expect(deleteTableRow(T, 0)).toBe(T)
    expect(deleteTableColumn(T, 0)).toBe('| b |\n| :-: |\n| 2 |\n| 4 |')
  })

  it('deplacer une ligne, une colonne (avec son alignement)', () => {
    expect(moveTableRow(T, 1, 1)).toBe('| a | b |\n| --- | :-: |\n| 3 | 4 |\n| 1 | 2 |')
    expect(moveTableRow(T, 1, -1)).toBe(T)
    expect(moveTableColumn(T, 0, 1)).toBe('| b | a |\n| :-: | --- |\n| 2 | 1 |\n| 4 | 3 |')
    expect(moveTableColumn(T, 1, 1)).toBe(T)
  })
})

describe('Ecrire sous un callout ou un tableau', () => {
  it.each([
    ['callout', '> [!NOTE]\n> dedans\n'],
    ['tableau', '| a | b |\n|---|---|\n| 1 | 2 |\n'],
  ])('%s : le texte va dessous, une ligne vide entre les deux', (_name, doc) => {
    for (const mode of ['power', 'classic'] as const) {
      const view = setup(doc, doc.length, mode)
      type(view, 'x')
      expect(view.state.doc.toString()).toBe(`${doc}\nx`)
      view.destroy()
    }
  })

  it('`>` ou `|` continuent le bloc', () => {
    const doc = '> une citation\n'
    const view = setup(doc, doc.length, 'power')
    type(view, '>')
    expect(view.state.doc.toString()).toBe(`${doc}>`)
    view.destroy()
  })
})

describe('Les fleches entrent dans un callout (mode classique)', () => {
  const DOC = 'avant\n\n> [!TODO] Courses\n> pain\n> lait\n\napres'

  it('par le haut : le titre, puis le corps, puis la ligne dessous', async () => {
    const view = setup(DOC, 0, 'classic', await calloutRegistry())
    expect(noteKey(view, 'ArrowDown')).toBe(true) // ligne vide
    expect(noteKey(view, 'ArrowDown')).toBe(true)
    const title = document.activeElement as HTMLInputElement
    expect(title.dataset.testid).toBe('callout-title')
    expect(title.value).toBe('Courses')

    fieldKey('ArrowDown')
    const body = document.activeElement as HTMLTextAreaElement
    expect(body.dataset.testid).toBe('callout-editor')
    expect(body.value).toBe('pain\nlait')
    expect(body.selectionStart).toBe(0)
    // Fleche haut au debut du corps : le titre.
    fieldKey('ArrowUp')
    expect((document.activeElement as HTMLElement).dataset.testid).toBe('callout-title')
    fieldKey('ArrowDown')
    const area = document.activeElement as HTMLTextAreaElement
    area.setSelectionRange(area.value.length, area.value.length)
    fieldKey('ArrowDown')
    expect(view.hasFocus || document.activeElement === view.contentDOM).toBe(true)
    expect(lineOf(view)).toBe(6)
    view.destroy()
  })

  it('par le bas : la fin du corps ; le titre se renomme', async () => {
    const view = setup(DOC, DOC.length, 'classic', await calloutRegistry())
    noteKey(view, 'ArrowUp') // ligne vide
    noteKey(view, 'ArrowUp')
    const body = document.activeElement as HTMLTextAreaElement
    expect(body.dataset.testid).toBe('callout-editor')
    expect(body.selectionStart).toBe(body.value.length)
    fieldKey('ArrowUp', {})
    body.setSelectionRange(0, 0)
    fieldKey('ArrowUp')
    const title = document.activeElement as HTMLInputElement
    title.value = 'Liste'
    title.dispatchEvent(new Event('input'))
    fieldKey('ArrowUp')
    expect(view.state.doc.toString()).toContain('> [!TODO] Liste\n> pain')
    expect(lineOf(view)).toBe(2)
    view.destroy()
  })
})

describe('Les fleches entrent dans un tableau (mode classique)', () => {
  const DOC = 'avant\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\napres'
  const cell = () => (document.activeElement as HTMLElement).closest('.plume-table-cell') as HTMLElement

  it('case par case, puis la ligne dessous ; Tab au bout ajoute une ligne', async () => {
    const view = setup(DOC, 0, 'classic')
    noteKey(view, 'ArrowDown')
    noteKey(view, 'ArrowDown')
    expect(cell().classList.contains('plume-table-cell')).toBe(true)
    expect([cell().dataset.row, cell().dataset.col]).toEqual(['0', '0'])
    fieldKey('ArrowDown')
    expect(cell().dataset.row).toBe('1')
    fieldKey('ArrowDown')
    expect(lineOf(view)).toBe(6)

    noteKey(view, 'ArrowUp')
    expect(cell().dataset.row).toBe('1')
    fieldKey('Tab')
    fieldKey('Tab')
    expect(view.state.doc.toString()).toContain('| 1 | 2 |\n|  |  |')
    await new Promise(r => requestAnimationFrame(r))
    expect([cell().dataset.row, cell().dataset.col]).toEqual(['2', '0'])
    view.destroy()
  })

  it('Alt + fleche deplace la ligne, la case la suit', async () => {
    const doc = '| a |\n|---|\n| 1 |\n| 2 |\n\nfin'
    const view = setup(doc, doc.length, 'classic')
    noteKey(view, 'ArrowUp')
    noteKey(view, 'ArrowUp')
    expect(cell().textContent).toBe('2')
    fieldKey('ArrowUp', { altKey: true })
    expect(view.state.doc.toString()).toBe('| a |\n| --- |\n| 2 |\n| 1 |\n\nfin')
    await new Promise(r => requestAnimationFrame(r))
    expect([cell().dataset.row, cell().textContent]).toEqual(['1', '2'])
    view.destroy()
  })
})

describe('Entree dans un tableau : une nouvelle ligne', () => {
  const cell = () => (document.activeElement as HTMLElement).closest('.plume-table-cell') as HTMLElement

  it('mode classique : Entree dans une case ajoute une ligne dessous, on ecrit dans sa premiere case', async () => {
    const doc = '| a | b |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |\n\nfin'
    const view = setup(doc, doc.length, 'classic')
    noteKey(view, 'ArrowUp')
    noteKey(view, 'ArrowUp')
    fieldKey('ArrowUp') // ligne « 1 | 2 »
    fieldKey('ArrowRight') // fin de case : la case suivante
    fieldKey('Enter')
    expect(view.state.doc.toString()).toBe('| a | b |\n| --- | --- |\n| 1 | 2 |\n|  |  |\n| 3 | 4 |\n\nfin')
    await new Promise(r => requestAnimationFrame(r))
    expect([cell().dataset.row, cell().dataset.col]).toEqual(['2', '0'])
    view.destroy()
  })

  it('texte brut : Entree sur une ligne du tableau en ajoute une (sous les tirets depuis l\'en-tete)', () => {
    const doc = '| a | b |\n|---|---|\n| 1 | 2 |'
    const view = setup(doc, doc.indexOf('1'), 'power')
    noteKey(view, 'Enter')
    expect(view.state.doc.toString()).toBe('| a | b |\n|---|---|\n| 1 | 2 |\n|   |   |')
    expect(view.state.selection.main.head).toBe(view.state.doc.line(4).from + 2)
    view.dispatch({ selection: { anchor: 3 } })
    noteKey(view, 'Enter')
    expect(view.state.doc.line(3).text).toBe('|   |   |')
    view.destroy()
  })
})

describe('Selectionner une ligne ou une colonne', () => {
  const DOC = 'avant\n\n| a | b |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |\n\nfin'
  const press = (key: string) => window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))

  it.each(['power', 'classic'] as const)('mode %s : la poignee selectionne, Suppr supprime', mode => {
    const view = setup(DOC, 0, mode)
    const cellOf = (text: string) => Array.from(view.contentDOM.querySelectorAll('td, th')).find(c => c.textContent === text)!
    // Survol de « 3 », puis la poignee de sa ligne.
    cellOf('3').dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
    view.contentDOM.querySelector('[data-testid="table-row-grip"]')!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))
    expect(Array.from(view.contentDOM.querySelectorAll('.plume-table-selected')).map(c => c.textContent)).toEqual(['3', '4'])
    expect(document.querySelector('[data-testid="block-menu-table-row-delete"]')?.textContent).toContain('Supprimer la ligne')
    press('Delete')
    expect(view.state.doc.toString()).toBe('avant\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\nfin')
    expect(document.querySelector('[data-testid="block-menu"]')).toBeNull()

    // Une colonne, avec Retour arriere.
    cellOf('b').dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
    view.contentDOM.querySelector('[data-testid="table-col-grip"]')!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))
    expect(Array.from(view.contentDOM.querySelectorAll('.plume-table-selected')).map(c => c.textContent)).toEqual(['b', '2'])
    press('Backspace')
    expect(view.state.doc.toString()).toBe('avant\n\n| a |\n| --- |\n| 1 |\n\nfin')
    view.destroy()
  })

  it('Echap deselectionne, rien n\'est supprime', () => {
    const view = setup(DOC, 0, 'classic')
    view.contentDOM.querySelector('td')!.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
    view.contentDOM.querySelector('[data-testid="table-row-grip"]')!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))
    press('Escape')
    press('Delete')
    expect(view.contentDOM.querySelectorAll('.plume-table-selected')).toHaveLength(0)
    expect(view.state.doc.toString()).toBe(DOC)
    view.destroy()
  })
})

describe('Le « + » d\'un tableau', () => {
  const TABLE = 'avant\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\nfin'
  const plus = (view: EditorView, kind: 'row' | 'col', cellText: string) => {
    const cell = Array.from(view.contentDOM.querySelectorAll('td, th')).find(c => c.textContent === cellText)!
    cell.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
    const b = view.contentDOM.querySelector(`[data-testid="table-${kind}-plus"]`) as HTMLElement
    expect(b.hidden).toBe(false)
    b.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))
  }

  it.each(['power', 'classic'] as const)('mode %s : une ligne sous celle survolee, une colonne a droite', mode => {
    const view = setup(TABLE, 0, mode)
    plus(view, 'row', 'a')
    expect(view.state.doc.toString()).toBe('avant\n\n| a | b |\n| --- | --- |\n|  |  |\n| 1 | 2 |\n\nfin')
    plus(view, 'col', 'a')
    expect(view.state.doc.toString().split('\n')[2]).toMatch(/^\| a \|\s+\| b \|$/)
    view.destroy()
  })
})

describe('Maj + fleche dans une liste : une ligne a la fois', () => {
  const doc = 'Avant\n\n- un\n- deux\n- trois\n- quatre\n\nApres'
  const shiftKey = (view: EditorView, key: string) =>
    runScopeHandlers(view, new KeyboardEvent('keydown', { key, shiftKey: true, bubbles: true, cancelable: true }), 'editor')
  const selected = (view: EditorView) => view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to)

  for (const mode of ['power', 'classic'] as const) {
    it(`descend puis remonte d'une ligne (${mode})`, () => {
      const view = setup(doc, doc.indexOf('un'), mode)
      expect(shiftKey(view, 'ArrowDown')).toBe(true)
      expect(selected(view)).toBe('un\n- ')
      shiftKey(view, 'ArrowDown')
      expect(selected(view)).toBe('un\n- deux\n- ')
      shiftKey(view, 'ArrowUp')
      expect(selected(view)).toBe('un\n- ')
      expect(view.state.selection.main.anchor).toBe(doc.indexOf('un'))
      view.destroy()
    })
  }

  it('la ligne ou la selection s\'arrete reste en texte', () => {
    const view = setup(doc, doc.indexOf('un'), 'power')
    shiftKey(view, 'ArrowDown')
    shiftKey(view, 'ArrowDown')
    const lines = [...view.contentDOM.children].map(el => el.className)
    // « - trois » (ligne 5) est une vraie ligne de l'editeur, pas un rendu.
    expect(view.domAtPos(view.state.doc.line(5).from + 3).node.parentElement?.closest('.cm-line')).not.toBeNull()
    expect(lines.some(c => c.includes('vault-rendered-block'))).toBe(true)
    view.destroy()
  })
})
