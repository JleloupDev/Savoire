// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Un plugin d'edition actif partout (defaultActive) charge APRES l'ouverture
// d'une note : ses blocs s'affichent sans rouvrir la note.
import { describe, it, expect } from 'vitest'
import { EditorCore } from '../../../../../packages/editor-core/src/EditorCore'
import type { BlockSpec, IEditorHostAPI, VaultPlugin } from '@savoire/plugin-api'

describe('plugin d edition charge apres la note', () => {
  it('EditorCore.refreshAll : le bloc apparait dans la note deja ouverte', async () => {
    const specs: BlockSpec[] = []
    const owner = new Map<string, string>()
    const blocks = {
      register: (s: BlockSpec) => { specs.push(s) },
      unregister: () => {},
      getAll: () => specs,
      detectBlock: (t: string) => { const s = specs.find(x => typeof x.detect === 'function' && x.detect(t)); return s ? { type: s.type, spec: s } : null },
      detectActive: (t: string, ids: Set<string> | null) => {
        const s = specs.find(x => typeof x.detect === 'function' && x.detect(t) && (ids === null || ids.has(owner.get(x.type) ?? '')))
        return s ? { type: s.type, spec: s } : null
      },
    }
    const noop = () => {}
    const api = {
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
    const defaults: VaultPlugin[] = []
    const container = document.createElement('div')
    document.body.appendChild(container)
    const editor = new EditorCore({
      container, pluginAPI: api, defaultPlugins: defaults, editorMode: 'rich', showLineNumbers: false,
      initialContent: 'avant\n\n```demo\nx\n```\n\napres', filePath: 'note.md',
    })
    await new Promise(r => setTimeout(r, 30))
    expect(container.querySelector('.demo-block')).toBeNull()

    // Le plugin arrive : il s'inscrit, l'appli le met dans les plugins par defaut.
    const plugin = { manifest: { id: 'plugin-demo', name: 'Demo', version: '1', defaultActive: true } } as unknown as VaultPlugin
    blocks.register({
      type: 'demo', detect: (t: string) => t.startsWith('```demo'), serialize: String, deserialize: String,
      createEditorWidget: () => ({ mount: noop, destroy: noop }),
      renderClient: () => { const el = document.createElement('div'); el.className = 'demo-block'; return el },
    })
    owner.set('demo', 'plugin-demo')
    defaults.push(plugin)
    EditorCore.refreshAll()
    expect(container.querySelector('.demo-block')).not.toBeNull()
    editor.destroy()
  })
})
