// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Note partagee : Annuler ne defait que ses propres modifications. Avant,
// l'historique de CodeMirror annulait aussi le texte recu (le chargement de
// la note) : un Ctrl+Z de trop vidait la note, chez tout le monde.
import { describe, it, expect } from 'vitest'
import { EditorView } from '../../../../../packages/editor-core/node_modules/@codemirror/view'
import { EditorCore, plumeCommands } from '../../../../../packages/editor-core/src/EditorCore'
import { YjsCrdtAdapter } from '../../../../../packages/infrastructure-sync/src/YjsCrdtAdapter'
import type { IEditorHostAPI, VaultPlugin } from '@savoire/plugin-api'

function hostApi(): IEditorHostAPI {
  const specs: unknown[] = []
  const blocks = { register: () => {}, unregister: () => {}, getAll: () => specs, detectBlock: () => null, detectActive: () => null }
  const noop = () => {}
  return {
    blocks,
    hooks: { runBeforeParseSync: (s: string) => s, beforeParse: noop, afterParse: noop, beforeRender: noop, afterRender: noop, onDocumentOpen: noop, onDocumentSave: noop, onSelectionChange: noop, onDocumentStabilized: noop, runBeforeParse: async (s: string) => s, runAfterRender: async (s: string) => s, runDocumentOpen: noop, runDocumentSave: noop, runDocumentStabilized: noop },
    commands: { register: noop, unregister: noop, getAll: () => [] },
    slash: { register: noop, unregister: noop, getAll: () => [] },
    toolbar: { register: noop, unregister: noop, getAll: () => [], getByGroup: () => [] },
    triggers: { register: noop, unregister: noop, getAll: () => [], findConflict: () => undefined },
    files: { register: noop, unregister: noop, resolve: () => undefined, getAll: () => [] },
    views: { register: noop, unregister: noop, getAll: () => [], registerGroup: noop, unregisterGroup: noop, getGroups: () => [] },
    vault: { read: async () => '', list: async () => [], exists: async () => false, resolveDocumentId: () => undefined },
    workspace: { openFile: async () => {}, openPanel: noop, closePanel: noop, getActiveDocument: () => undefined },
    editor: { getCursorCoords: () => null, getSelectionCoords: () => null, getSelectionText: () => '' },
    setEditorPositionAPI: noop,
  } as unknown as IEditorHostAPI
}

describe('annuler dans une note partagee', () => {
  it('ne defait pas le texte recu, seulement la frappe locale', async () => {
    const remote = new YjsCrdtAdapter()
    remote.sharedText().insert(0, 'Ma note entiere')
    const crdt = new YjsCrdtAdapter()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const editor = new EditorCore({
      container, pluginAPI: hostApi(), defaultPlugins: [] as VaultPlugin[], editorMode: 'source', showLineNumbers: false,
      crdt, filePath: 'note.md',
    })
    // Le contenu arrive du serveur apres l'ouverture.
    crdt.applyRemoteOp(remote.getSnapshot())
    const view = EditorView.findFromDOM(container.querySelector('.cm-editor') as HTMLElement)!
    expect(view.state.doc.toString()).toBe('Ma note entiere')

    view.dispatch({ changes: { from: view.state.doc.length, insert: ' !' }, userEvent: 'input.type' })
    expect(view.state.doc.toString()).toBe('Ma note entiere !')

    const undo = plumeCommands().find(c => c.id === 'editor:undo')!
    undo.run({ editorView: view } as never)
    expect(view.state.doc.toString()).toBe('Ma note entiere')
    // Rien de plus a annuler : la note reste.
    undo.run({ editorView: view } as never)
    undo.run({ editorView: view } as never)
    expect(view.state.doc.toString()).toBe('Ma note entiere')
    expect(remote.sharedText().toString()).toBe('Ma note entiere')
    editor.destroy()
  })
})
