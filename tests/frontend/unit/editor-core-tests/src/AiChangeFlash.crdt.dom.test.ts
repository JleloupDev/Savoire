// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Voir ce que fait l'IA, de bout en bout : le vrai editeur et le vrai CRDT.
// Une ecriture d'agent (faite ici, ou recue d'un autre) devient un point ;
// l'editeur la surligne, et la carte l'annule dans la note.
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { EditorView } from '../../../../../packages/editor-core/node_modules/@codemirror/view'
import { EditorCore } from '../../../../../packages/editor-core/src/EditorCore'
import { AI_FLASH_MS, aiChangeFlashes } from '../../../../../packages/editor-core/src/AiChangeFlash'
import { blockMarksOf } from '../../../../../packages/editor-core/src/BlockMarks'
import { YjsCrdtAdapter } from '../../../../../packages/infrastructure-sync/src/YjsCrdtAdapter'
import type { AiChangeMetaInput, IEditorHostAPI, VaultPlugin } from '@savoire/plugin-api'

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

const JEAN = { id: 'u1', name: 'Jean' }
const META: AiChangeMetaInput = { agent: { id: 'a1', name: 'Archiviste', color: '#00aa77' }, forUser: JEAN, summary: 'texte ajouté', reason: 'demandé dans la discussion' }

const editors: EditorCore[] = []
beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(Date.parse('2026-11-25T10:00:00Z'))
})
afterEach(() => {
  for (const e of editors.splice(0)) e.destroy()
  vi.useRealTimers()
})

function mount(crdt: YjsCrdtAdapter) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const editor = new EditorCore({
    container, pluginAPI: hostApi(), defaultPlugins: [] as VaultPlugin[], editorMode: 'source', showLineNumbers: false,
    crdt, filePath: 'note.md', docId: 'doc-1',
  })
  editors.push(editor)
  const view = EditorView.findFromDOM(container.querySelector('.cm-editor') as HTMLElement)!
  const flashed = () => Array.from(view.dom.querySelectorAll('.cm-ai-flash')).map(el => el.textContent)
  const card = () => view.dom.querySelector('[data-testid="ai-change-card"]') as HTMLElement | null
  return { editor, view, flashed, card }
}

/** Ce que fait un agent sur ce CRDT : `fn` devient un point. */
function agentWrites(crdt: YjsCrdtAdapter, fn: () => void, meta = META): string {
  const recording = crdt.beginAiChange(meta)
  recording.capture(fn)
  return recording.commit()!
}

/** Ce que `from` a de plus arrive chez `to` (le reseau). */
function sync(from: YjsCrdtAdapter, to: YjsCrdtAdapter): void {
  to.applyRemoteOp(from.getSnapshot())
}

describe('voir ce que fait l IA, avec le vrai CRDT', () => {
  it('un agent ecrit ici : son texte est surligne, la carte l annule, l appli montre le point', async () => {
    const crdt = new YjsCrdtAdapter()
    const e = mount(crdt)
    crdt.sharedText().insert(0, 'Bonjour. Fin.')
    const shown: unknown[] = []
    e.editor.setAiChangeHost({ me: () => JEAN, showHistory: (docId, id) => { shown.push({ docId, id }) } })

    const id = agentWrites(crdt, () => crdt.sharedText().insert(9, 'Texte de l’IA. '))
    await Promise.resolve()
    expect(e.view.state.doc.toString()).toBe('Bonjour. Texte de l’IA. Fin.')
    expect(e.flashed()).toEqual(['Texte de l’IA. '])
    expect(aiChangeFlashes(e.view.state)).toMatchObject([{ id, color: '#00aa77', inserted: [{ from: 9, to: 24 }] }])
    expect([...blockMarksOf(e.view).values()].flat()).toMatchObject([{ from: 9, to: 24, color: '#00aa77' }])

    // La personne tape avant : la zone suit.
    e.view.dispatch({ changes: { from: 0, insert: '> ' }, userEvent: 'input.type' })
    expect(e.flashed()).toEqual(['Texte de l’IA. '])

    // Survol : la carte, puis « Annuler ».
    e.view.dom.querySelector('.cm-ai-flash')!.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }))
    vi.advanceTimersByTime(300)
    expect(e.card()!.querySelector('[data-testid="ai-change-who"]')!.textContent).toBe('Archiviste (IA), pour Jean')
    expect(e.card()!.querySelector('.cm-ai-change-summary')!.textContent).toBe('Texte ajouté')
    expect(e.card()!.querySelector('.cm-ai-change-reason')!.textContent).toBe('demandé dans la discussion')
    ;(e.card()!.querySelector('[data-testid="ai-change-undo"]') as HTMLElement).click()
    expect(e.view.state.doc.toString()).toBe('> Bonjour. Fin.')
    expect(crdt.aiChanges()[0]!.undone?.by).toEqual(JEAN)
    expect(e.card()!.querySelector('[data-testid="ai-change-status"]')!.textContent).toBe('Modification annulée.')
    expect(e.flashed()).toEqual([])
    expect([...blockMarksOf(e.view).values()].flat()).toEqual([])

    ;(e.card()!.querySelector('[data-testid="ai-change-history"]') as HTMLElement).click()
    expect(shown).toEqual([{ docId: 'doc-1', id }])
    expect(e.card()).toBeNull()
  })

  it('un point recu d un autre (IA externe, autre appareil) : surligne aussi, remplacement compris', async () => {
    const remote = new YjsCrdtAdapter()
    remote.sharedText().insert(0, 'Un. Deux mots ici. Trois.')
    const crdt = new YjsCrdtAdapter()
    const e = mount(crdt)
    sync(remote, crdt)
    await Promise.resolve()
    expect(e.view.state.doc.toString()).toBe('Un. Deux mots ici. Trois.')
    expect(e.flashed()).toEqual([])

    vi.advanceTimersByTime(3000)
    agentWrites(remote, () => { remote.sharedText().delete(4, 14); remote.sharedText().insert(4, 'Autre chose.') })
    sync(remote, crdt)
    await Promise.resolve()
    expect(e.view.state.doc.toString()).toBe('Un. Autre chose. Trois.')
    expect(e.flashed()).toEqual(['Autre chose.'])
    // L'ancien texte, barre, devant le nouveau.
    const trace = e.view.dom.querySelector('[data-testid="ai-flash-deleted"]') as HTMLElement
    expect(trace.textContent).toBe('Deux mots ici.')
    expect(e.view.posAtDOM(trace)).toBe(4)

    vi.advanceTimersByTime(AI_FLASH_MS + 400)
    expect(e.flashed()).toEqual([])
    expect(e.view.dom.querySelector('[data-testid="ai-flash-deleted"]')).toBeNull()
    expect(e.view.state.doc.toString()).toBe('Un. Autre chose. Trois.')
  })

  it('a l ouverture de la note, les points deja la ne sont pas montres', async () => {
    const remote = new YjsCrdtAdapter()
    remote.sharedText().insert(0, 'Bonjour. Fin.')
    agentWrites(remote, () => remote.sharedText().insert(9, 'Texte de l’IA. '))
    // On ouvre la note dix secondes apres.
    vi.advanceTimersByTime(10_000)
    const crdt = new YjsCrdtAdapter()
    const e = mount(crdt)
    sync(remote, crdt)
    await Promise.resolve()
    expect(e.view.state.doc.toString()).toBe('Bonjour. Texte de l’IA. Fin.')
    expect(crdt.aiChanges()).toHaveLength(1)
    expect(e.flashed()).toEqual([])
    expect(aiChangeFlashes(e.view.state)).toEqual([])
  })
})
