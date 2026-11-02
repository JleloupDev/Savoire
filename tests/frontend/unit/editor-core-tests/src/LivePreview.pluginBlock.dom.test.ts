// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Rendu d'un bloc de plugin dans Plume : construit seulement quand il est
// affiche (pas a chaque frappe), et prevenu quand l'editeur le retire.
import { describe, it, expect, vi } from 'vitest'
import { EditorView } from '@codemirror/view'
import { EditorState, EditorSelection } from '@codemirror/state'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { createLivePreviewExtension } from '../../../../../packages/editor-core/src/LivePreview'
import { BLOCK_DESTROY_EVENT } from '@savoire/plugin-api'
import type { BlockRegistry, BlockSpec } from '@savoire/plugin-api'

const DOC = 'avant\n\n```demo\nx\n```\n\napres'

function setup() {
  const destroyed = vi.fn()
  const renderClient = vi.fn(() => {
    const el = document.createElement('div')
    el.className = 'demo-block'
    el.addEventListener(BLOCK_DESTROY_EVENT, destroyed)
    return el
  })
  const spec: BlockSpec = {
    type: 'demo',
    detect: text => text.startsWith('```demo'),
    serialize: d => String(d),
    deserialize: raw => raw,
    createEditorWidget: () => ({ mount: () => {}, destroy: () => {} }),
    renderClient,
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
      doc: DOC,
      selection: EditorSelection.cursor(0),
      extensions: [markdown({ base: markdownLanguage }), ...createLivePreviewExtension(registry, undefined, { editorView: null }, false)],
    }),
  })
  return { view, renderClient, destroyed }
}

describe('LivePreview : bloc de plugin', () => {
  it('ne reconstruit pas le rendu quand on tape ailleurs', () => {
    const { view, renderClient } = setup()
    expect(view.dom.querySelectorAll('.demo-block')).toHaveLength(1)
    const before = renderClient.mock.calls.length
    for (let i = 0; i < 5; i++) view.dispatch({ changes: { from: 0, insert: 'a' }, selection: EditorSelection.cursor(i + 1) })
    expect(renderClient.mock.calls.length).toBe(before)
    view.destroy()
  })

  it('previent le rendu quand le bloc est modifie ou la note fermee', () => {
    const { view, destroyed } = setup()
    // Le curseur entre dans le bloc : il repasse en texte, le rendu est retire.
    const pos = view.state.doc.toString().indexOf('x')
    view.dispatch({ selection: EditorSelection.cursor(pos) })
    expect(view.dom.querySelectorAll('.demo-block')).toHaveLength(0)
    expect(destroyed).toHaveBeenCalledTimes(1)
    // Il en sort : nouveau rendu, retire a la fermeture.
    view.dispatch({ selection: EditorSelection.cursor(0) })
    expect(view.dom.querySelectorAll('.demo-block')).toHaveLength(1)
    view.destroy()
    expect(destroyed).toHaveBeenCalledTimes(2)
  })
})
