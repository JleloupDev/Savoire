// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import { describe, it, expect } from 'vitest'
import * as Y from 'yjs'
import { AnchorIndex, resolveEntry, validateEntry } from '../AnchorIndex'
import { anchorKey } from '../AnchorHandle'
import { IndexEngine } from '../IndexEngine'
import type { AnchorContributor } from '../IndexContributor'
import type { ICollaborativeText } from '../ICollaborativeText'
import { makeDoc, cloneDoc, syncTo, YjsTestText } from './helpers'

// ── Test fixture — minimal hashtag contributor ─────────────────────────────────
// Contributors live in plugins; this is an inline replica for domain-index tests.

const HASHTAG_RE = /(?<![[\w])#[\w\u00C0-\u017E]+/g

class TestHashtagContributor implements AnchorContributor {
  readonly namespace = 'hashtags'
  private _processedSeq = -1
  get processedSeq() { return this._processedSeq }
  restore(_s: string, seq: number) { this._processedSeq = seq }
  snapshot() { return '{}' }
  onOp(seq: number | null) { if (seq !== null) this._processedSeq = seq }

  onTextChange(text: ICollaborativeText, docId: string, index: AnchorIndex): void {
    const str = text.toString()
    for (const entry of index.getByDoc(this.namespace, docId)) {
      if (validateEntry(entry, text) === 'invalid') index.remove(entry.id)
    }
    HASHTAG_RE.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = HASHTAG_RE.exec(str)) !== null) {
      const value = m[0]
      const start = m.index
      const end = start + value.length
      const a1 = text.createRelPos(start, 0)
      const a2 = text.createRelPos(end, -1)
      const id = `hashtags|${docId}|${anchorKey(a1)}|${anchorKey(a2)}`
      index.add({ id, namespace: 'hashtags', value, docId, anchor1: a1, anchor2: a2 })
    }
  }
}

function makeHashtagEntry(
  text: YjsTestText,
  docId: string,
  start: number,
  end: number,
  value: string,
) {
  const a1 = text.createRelPos(start, 0)
  const a2 = text.createRelPos(end, -1)
  const id = `hashtags|${docId}|${anchorKey(a1)}|${anchorKey(a2)}`
  return { id, namespace: 'hashtags', value, docId, anchor1: a1, anchor2: a2 }
}

// ── S1 — Anchor determinism ────────────────────────────────────────────────────

describe('S1 — anchor determinism (central hypothesis)', () => {
  it('two peers anchoring the same token produce the same entry id', () => {
    const { doc: docA, text: textA } = makeDoc('hello #salut world')
    const { text: textB } = cloneDoc(docA)

    const eA = makeHashtagEntry(textA, 'doc1', 6, 12, '#salut')
    const eB = makeHashtagEntry(textB, 'doc1', 6, 12, '#salut')

    expect(eA.id).toBe(eB.id)
    expect(eA.anchor1).toEqual(eB.anchor1)
    expect(eA.anchor2).toEqual(eB.anchor2)
  })

  it('add() with the same id is idempotent — no duplicates', () => {
    const { text } = makeDoc('hello #salut world')
    const index = new AnchorIndex()

    const e1 = makeHashtagEntry(text, 'doc1', 6, 12, '#salut')
    const e2 = makeHashtagEntry(text, 'doc1', 6, 12, '#salut')
    index.add(e1)
    index.add(e2)

    expect(index.getByValue('hashtags', '#salut')).toHaveLength(1)
  })
})

// ── S2 — Insertion before the token ───────────────────────────────────────────

describe('S2 — insertion before the token', () => {
  it('anchors remain valid after text inserted before the hashtag', () => {
    const { doc, ytext, text } = makeDoc('hello #salut world')
    const entry = makeHashtagEntry(text, 'doc1', 6, 12, '#salut')

    ytext.insert(6, 'XXXX ')
    expect(ytext.toString()).toBe('hello XXXX #salut world')

    const resolved = resolveEntry(entry, new YjsTestText(ytext, doc))
    expect(resolved).not.toBeNull()
    expect(resolved!.currentValue).toBe('#salut')
    expect(validateEntry(entry, new YjsTestText(ytext, doc))).toBe('valid')
  })
})

// ── S3 — Insertion inside the token ───────────────────────────────────────────

describe('S3 — insertion inside the token', () => {
  it('detects invalidation and the index reflects the new value after re-indexing', () => {
    const { doc, ytext, text } = makeDoc('hello #salut world')
    const engine = new IndexEngine()
    engine.register(new TestHashtagContributor())
    engine.onTextChange(text, 'doc1')

    const originalId = engine.getByValue('hashtags', '#salut')[0]!.id

    ytext.insert(9, 'X')
    expect(ytext.toString()).toBe('hello #saXlut world')
    engine.onTextChange(new YjsTestText(ytext, doc), 'doc1')

    expect(engine.getByValue('hashtags', '#salut')).toHaveLength(0)
    expect(engine.getByValue('hashtags', '#saXlut')).toHaveLength(1)
    // Same anchor pair (#→t) → same ID → entry carries the updated value
    expect(engine.getByDoc('hashtags', 'doc1').find(e => e.id === originalId)?.value).toBe('#saXlut')
  })
})

// ── S4 — Token deletion ────────────────────────────────────────────────────────

describe('S4 — token deletion', () => {
  it('removes the entry when the hashtag is deleted', () => {
    const { doc, ytext, text } = makeDoc('hello #salut world')
    const engine = new IndexEngine()
    engine.register(new TestHashtagContributor())
    engine.onTextChange(text, 'doc1')
    expect(engine.size).toBe(1)

    ytext.delete(6, 6)
    engine.onTextChange(new YjsTestText(ytext, doc), 'doc1')

    expect(engine.size).toBe(0)
  })

  it('remove(id) is idempotent', () => {
    const { text } = makeDoc('#salut')
    const index = new AnchorIndex()
    const entry = makeHashtagEntry(text, 'doc1', 0, 6, '#salut')
    index.add(entry)
    index.remove(entry.id)
    index.remove(entry.id)
    expect(index.size).toBe(0)
  })
})

// ── S5 — P2P convergence ──────────────────────────────────────────────────────

describe('S5 — P2P convergence after offline edits', () => {
  it('both peers end up with the same index after cross-sync', () => {
    const docA = new Y.Doc(); docA.gc = false
    const { doc: docB } = cloneDoc(docA)

    const engineA = new IndexEngine(); engineA.register(new TestHashtagContributor())
    const engineB = new IndexEngine(); engineB.register(new TestHashtagContributor())

    docA.getText('content').insert(0, '#salut ')
    engineA.onTextChange(new YjsTestText(docA.getText('content'), docA), 'doc1')

    docB.getText('content').insert(0, '#todo ')
    engineB.onTextChange(new YjsTestText(docB.getText('content'), docB), 'doc1')

    syncTo(docA, docB); syncTo(docB, docA)

    expect(docA.getText('content').toString()).toBe(docB.getText('content').toString())

    engineA.onTextChange(new YjsTestText(docA.getText('content'), docA), 'doc1')
    engineB.onTextChange(new YjsTestText(docB.getText('content'), docB), 'doc1')

    const idsA = engineA.getByDoc('hashtags', 'doc1').map(e => e.id).sort()
    const idsB = engineB.getByDoc('hashtags', 'doc1').map(e => e.id).sort()
    expect(idsA).toEqual(idsB)
    expect(engineA.getByValue('hashtags', '#salut')).toHaveLength(1)
    expect(engineA.getByValue('hashtags', '#todo')).toHaveLength(1)
  })
})

// ── S6 — Staleness detection ───────────────────────────────────────────────────

describe('S6 — staleness detection on vault snapshot', () => {
  it('flags a doc with entries when peer clock is higher than last indexed', () => {
    const { text } = makeDoc('#salut')
    const engine = new IndexEngine()
    engine.register(new TestHashtagContributor())
    engine.onTextChange(text, 'doc1')

    engine.checkStaleness('doc1', { clock: 9999 })
    expect(engine.revalidationQueue.has('doc1')).toBe(true)
  })

  it('does not flag a doc with no index entries', () => {
    const index = new AnchorIndex()
    index.checkStaleness('doc2', { clock: 9999 })
    expect(index.revalidationQueue.has('doc2')).toBe(false)
  })

  it('clears the flag after revalidation', () => {
    const { text } = makeDoc('#salut')
    const engine = new IndexEngine()
    engine.register(new TestHashtagContributor())
    engine.onTextChange(text, 'doc1')

    engine.checkStaleness('doc1', { clock: 9999 })
    expect(engine.revalidationQueue.has('doc1')).toBe(true)

    engine.onTextChange(text, 'doc1')
    expect(engine.revalidationQueue.has('doc1')).toBe(false)
  })
})

// ── A1 — add() early-return optimization ──────────────────────────────────────

describe('A1 — add() skips reindex when value and meta are unchanged', () => {
  it('calling add() twice with same entry does not duplicate byValue entries', () => {
    const { text } = makeDoc('#salut')
    const index = new AnchorIndex()
    const entry = makeHashtagEntry(text, 'doc1', 0, 6, '#salut')
    index.add(entry)
    index.add({ ...entry })
    expect(index.getByValue('hashtags', '#salut')).toHaveLength(1)
    expect(index.size).toBe(1)
  })
})
