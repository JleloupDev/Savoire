// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import { describe, it, expect, beforeEach } from 'vitest'
import * as Y from 'yjs'
import { YjsCrdtAdapter } from '@savoire/infrastructure-sync'
import { IndexEngine } from '@savoire/domain-index'
import { RealtimeIndexingService } from '@savoire/application'
import type { ITextChangeSource } from '@savoire/application'
import type { ICollaborativeText } from '@savoire/domain-index'
import { WikilinkIndexContributor } from '@savoire/plugin-wikilinks'
import { HashtagIndexContributor } from '@savoire/plugin-hashtags'
import { IndexRegistryImpl } from '@savoire/plugin-runtime'

// Inserts text into a fresh Y.Doc and returns an encoded op that can be
// applied to any Y.Doc sharing the same structure (getText('codemirror')).
function makeInsertOp(content: string): Uint8Array {
  const doc = new Y.Doc()
  doc.getText('codemirror').insert(0, content)
  return Y.encodeStateAsUpdate(doc)
}

// Fires synchronously: sets up adapter, subscribes to onTextChange, applies op,
// then returns the ICollaborativeText received by the callback.
function applyAndCapture(adapter: YjsCrdtAdapter, op: Uint8Array): ICollaborativeText {
  let captured: ICollaborativeText | undefined
  const unsub = adapter.onTextChange((text) => { captured = text })
  adapter.applyRemoteOp(op)
  unsub()
  if (!captured) throw new Error('onTextChange did not fire')
  return captured
}

// ─── IndexEngine + contributors ───────────────────────────────────────────────

describe('IndexEngine + WikilinkIndexContributor', () => {
  let adapter: YjsCrdtAdapter
  let engine: IndexEngine
  let contributor: WikilinkIndexContributor

  beforeEach(() => {
    adapter = new YjsCrdtAdapter()
    contributor = new WikilinkIndexContributor()
    engine = new IndexEngine()
    engine.register(contributor)
  })

  it('adds anchor entry when wikilink appears in CRDT text', () => {
    const text = applyAndCapture(adapter, makeInsertOp('See [[project-alpha]] for details'))
    engine.onTextChange(text, 'doc-1')

    const entries = engine.getByValue('wikilinks', 'project-alpha')
    expect(entries).toHaveLength(1)
    expect(entries[0].docId).toBe('doc-1')
  })

  it('resolves anchor to correct absolute position', () => {
    const content = '[[my-note]]'
    const text = applyAndCapture(adapter, makeInsertOp(content))
    engine.onTextChange(text, 'doc-1')

    const entries = engine.getByValue('wikilinks', 'my-note')
    expect(entries).toHaveLength(1)
    const start = text.resolveRelPos(entries[0].anchor1!)
    const end   = text.resolveRelPos(entries[0].anchor2!)
    expect(start).toBe(2)         // inside [[
    expect(end).toBe(9)           // end of 'my-note'
    expect(text.slice(start!, end!)).toBe('my-note')
  })

  it('anchor survives text insertion before the wikilink', () => {
    // First op: insert the wikilink
    const op1 = makeInsertOp('[[page]]')
    const text1 = applyAndCapture(adapter, op1)
    engine.onTextChange(text1, 'doc-1')

    // Second op: insert a prefix before it (simulated via a second peer doc)
    const prefixDoc = new Y.Doc()
    Y.applyUpdate(prefixDoc, op1)
    prefixDoc.getText('codemirror').insert(0, 'prefix ')
    const op2 = Y.encodeStateAsUpdate(prefixDoc)

    const text2 = applyAndCapture(adapter, op2)
    engine.onTextChange(text2, 'doc-1')

    // 'prefix [[page]]' → anchor should resolve to offset 9 (2 + 7)
    const entries = engine.getByValue('wikilinks', 'page')
    expect(entries).toHaveLength(1)
    const start = text2.resolveRelPos(entries[0].anchor1!)
    expect(start).toBe(9)
    expect(text2.slice(start!, start! + 4)).toBe('page')
  })

  it('removes stale anchor when wikilink is deleted', () => {
    const op1 = makeInsertOp('[[gone-note]]')
    const text1 = applyAndCapture(adapter, op1)
    engine.onTextChange(text1, 'doc-1')
    expect(engine.getByValue('wikilinks', 'gone-note')).toHaveLength(1)

    // Delete the wikilink entirely
    const deleteDoc = new Y.Doc()
    Y.applyUpdate(deleteDoc, op1)
    deleteDoc.getText('codemirror').delete(0, 13)
    const op2 = Y.encodeStateAsUpdate(deleteDoc)

    const text2 = applyAndCapture(adapter, op2)
    engine.onTextChange(text2, 'doc-1')

    expect(engine.getByValue('wikilinks', 'gone-note')).toHaveLength(0)
  })

  it('scopes anchors per docId — two documents do not interfere', () => {
    const adapter2 = new YjsCrdtAdapter()

    const text1 = applyAndCapture(adapter,  makeInsertOp('[[note-a]]'))
    const text2 = applyAndCapture(adapter2, makeInsertOp('[[note-b]]'))

    engine.onTextChange(text1, 'doc-1')
    engine.onTextChange(text2, 'doc-2')

    expect(engine.getByDoc('wikilinks', 'doc-1').map(e => e.value)).toContain('note-a')
    expect(engine.getByDoc('wikilinks', 'doc-2').map(e => e.value)).toContain('note-b')
    expect(engine.getByDoc('wikilinks', 'doc-1').map(e => e.value)).not.toContain('note-b')
    expect(engine.getByDoc('wikilinks', 'doc-2').map(e => e.value)).not.toContain('note-a')

    adapter2.dispose()
  })
})

// ─── HashtagIndexContributor ──────────────────────────────────────────────────

describe('IndexEngine + HashtagIndexContributor', () => {
  let adapter: YjsCrdtAdapter
  let engine: IndexEngine

  beforeEach(() => {
    adapter = new YjsCrdtAdapter()
    engine = new IndexEngine()
    engine.register(new HashtagIndexContributor())
  })

  it('adds anchor entry for hashtag', () => {
    const text = applyAndCapture(adapter, makeInsertOp('Status: #working'))
    engine.onTextChange(text, 'doc-1')
    expect(engine.getByValue('hashtags', '#working')).toHaveLength(1)
  })

  it('resolves hashtag anchor to correct position', () => {
    const content = '#done'
    const text = applyAndCapture(adapter, makeInsertOp(content))
    engine.onTextChange(text, 'doc-1')

    const entries = engine.getByValue('hashtags', '#done')
    expect(entries).toHaveLength(1)
    const start = text.resolveRelPos(entries[0].anchor1!)
    const end   = text.resolveRelPos(entries[0].anchor2!)
    expect(text.slice(start!, end!)).toBe('#done')
  })
})

// ─── RealtimeIndexingService + proxy contributor pattern ─────────────────────

describe('RealtimeIndexingService wiring', () => {
  it('routes CRDT text changes through the service to the engine', () => {
    const adapter = new YjsCrdtAdapter()
    const contributor = new WikilinkIndexContributor()
    const engine = new IndexEngine()
    engine.register(contributor)

    const handlers = new Set<(docId: string, text: ICollaborativeText) => void>()
    const source: ITextChangeSource = {
      subscribe(h) { handlers.add(h); return () => handlers.delete(h) },
    }
    const noopGateway = { broadcast: () => {}, onRemote: () => () => {} }
    const service = new RealtimeIndexingService(source, engine, noopGateway)
    service.start()

    // Simulate what EditorAreaWidget does: emit CRDT text change to the source
    const unsub = adapter.onTextChange((text) => {
      for (const h of handlers) h('doc-1', text)
    })

    adapter.applyRemoteOp(makeInsertOp('Check [[service-wired]]'))
    unsub()
    service.stop()

    expect(engine.getByValue('wikilinks', 'service-wired')).toHaveLength(1)
    adapter.dispose()
  })

  it('stop() unsubscribes — changes after stop are ignored', () => {
    const adapter = new YjsCrdtAdapter()
    const contributor = new WikilinkIndexContributor()
    const engine = new IndexEngine()
    engine.register(contributor)

    const handlers = new Set<(docId: string, text: ICollaborativeText) => void>()
    const source: ITextChangeSource = {
      subscribe(h) { handlers.add(h); return () => handlers.delete(h) },
    }
    const service = new RealtimeIndexingService(source, engine, { broadcast: () => {}, onRemote: () => () => {} })
    service.start()
    service.stop()

    // Changes after stop should not reach the engine
    for (const h of handlers) adapter.onTextChange((text) => h('doc-1', text))
    adapter.applyRemoteOp(makeInsertOp('[[ignored-after-stop]]'))

    expect(engine.getByValue('wikilinks', 'ignored-after-stop')).toHaveLength(0)
    adapter.dispose()
  })
})

// ─── Proxy contributor pattern (vault switch) ─────────────────────────────────

describe('proxy contributor — vault switch', () => {
  it('picks up new contributor instances after registry rebuild', () => {
    const registry = new IndexRegistryImpl()
    registry.registerFactory(() => new WikilinkIndexContributor())

    const engine = new IndexEngine()
    engine.register({
      namespace: '__proxy__',
      processedSeq: 0,
      onOp: () => {},
      restore: () => {},
      snapshot: () => '{}',
      onTextChange(text, docId, index) {
        for (const c of registry.getAll()) c.onTextChange?.(text, docId, index)
      },
    })

    const adapter = new YjsCrdtAdapter()

    // Before vault switch
    const text1 = applyAndCapture(adapter, makeInsertOp('[[before-switch]]'))
    engine.onTextChange(text1, 'doc-1')
    expect(engine.getByValue('wikilinks', 'before-switch')).toHaveLength(1)

    // Vault switch — new contributor instances
    registry.rebuild()

    const adapter2 = new YjsCrdtAdapter()
    const text2 = applyAndCapture(adapter2, makeInsertOp('[[after-switch]]'))
    engine.onTextChange(text2, 'doc-2')

    // New contributor instance receives the call
    expect(engine.getByValue('wikilinks', 'after-switch')).toHaveLength(1)

    adapter.dispose()
    adapter2.dispose()
  })
})
