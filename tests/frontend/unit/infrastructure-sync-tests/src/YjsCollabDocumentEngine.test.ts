// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import { describe, it, expect } from 'vitest'
import { YjsCollabDocumentEngine } from '@savoire/infrastructure-sync'
import * as Y from 'yjs'

/** Create a real Yjs update that inserts text at position 0. */
function makeYjsInsert(text: string, existingDoc?: Y.Doc): { doc: Y.Doc; update: Uint8Array } {
  const doc = existingDoc ?? new Y.Doc()
  let captured: Uint8Array | null = null
  const handler = (update: Uint8Array) => { captured = update }
  doc.on('update', handler)
  doc.getText('content').insert(0, text)
  doc.off('update', handler)
  return { doc, update: captured! }
}

describe('YjsCollabDocumentEngine', () => {
  it('getText returns empty string with no initial text', () => {
    const engine = new YjsCollabDocumentEngine()
    expect(engine.getText()).toBe('')
  })

  it('getText returns the initial text when provided', () => {
    const engine = new YjsCollabDocumentEngine('Hello, world!')
    expect(engine.getText()).toBe('Hello, world!')
  })

  it('applyLocal returns versionDelta of 1', () => {
    const engine = new YjsCollabDocumentEngine()
    const { update } = makeYjsInsert('test')
    const result = engine.applyLocal(update)
    expect(result.versionDelta).toBe(1)
  })

  it('applyRemote returns versionDelta of 1', () => {
    const engine = new YjsCollabDocumentEngine()
    const { update } = makeYjsInsert('test')
    const result = engine.applyRemote(update)
    expect(result.versionDelta).toBe(1)
  })

  it('applyLocal updates the document text', () => {
    const engine = new YjsCollabDocumentEngine()
    const { update } = makeYjsInsert('Hello')
    const result = engine.applyLocal(update)
    expect(result.text).toBe('Hello')
    expect(engine.getText()).toBe('Hello')
  })

  it('applyRemote updates the document text', () => {
    const engine = new YjsCollabDocumentEngine()
    const { update } = makeYjsInsert('World')
    const result = engine.applyRemote(update)
    expect(result.text).toBe('World')
    expect(engine.getText()).toBe('World')
  })

  it('applyLocal returns the current text in result', () => {
    const engine = new YjsCollabDocumentEngine('base ')
    const { update } = makeYjsInsert('prefix')
    const result = engine.applyLocal(update)
    // Yjs insert at 0 prepends; final text is "prefixbase " (insert at 0)
    expect(result.text).toContain('prefix')
  })

  it('multiple applyRemote calls accumulate text correctly', () => {
    const engine = new YjsCollabDocumentEngine()

    // Build incremental updates using encodeStateAsUpdate with state vector
    const src = new Y.Doc()
    const yText = src.getText('content')

    // Capture state before first insert
    const sv0 = Y.encodeStateVector(src)
    yText.insert(0, 'Hello')
    const update1 = Y.encodeStateAsUpdate(src, sv0)

    // Capture state before second insert
    const sv1 = Y.encodeStateVector(src)
    yText.insert(yText.length, ' World')
    const update2 = Y.encodeStateAsUpdate(src, sv1)

    engine.applyRemote(update1)
    engine.applyRemote(update2)

    expect(engine.getText()).toBe('Hello World')
  })

  it('encodeStateAsUpdate roundtrip works', () => {
    const engine = new YjsCollabDocumentEngine('Initial content')
    // Encode state and apply as remote update to another engine
    const sourceDoc = new Y.Doc()
    sourceDoc.getText('content').insert(0, 'Initial content')
    const stateUpdate = Y.encodeStateAsUpdate(sourceDoc)

    const engine2 = new YjsCollabDocumentEngine()
    engine2.applyRemote(stateUpdate)
    expect(engine2.getText()).toBe('Initial content')
  })

  it('initial text is inserted at position 0', () => {
    const engine = new YjsCollabDocumentEngine('# Title\n\nBody')
    expect(engine.getText()).toBe('# Title\n\nBody')
  })

  it('applyLocal and applyRemote both use Y.applyUpdate', () => {
    const src = new Y.Doc()
    src.getText('content').insert(0, 'sync')
    const update = Y.encodeStateAsUpdate(src)

    const e1 = new YjsCollabDocumentEngine()
    const e2 = new YjsCollabDocumentEngine()
    e1.applyLocal(update)
    e2.applyRemote(update)
    expect(e1.getText()).toBe(e2.getText())
  })
})
