// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import { describe, it, expect } from 'vitest'
import * as Y from 'yjs'
import {
  AnchorIndex,
  createRelPos,
  anchorKey,
  resolveEntry,
  validateEntry,
} from './AnchorIndex'
import { HashtagContributor } from './contributors/HashtagContributor'
import { IndexEngine } from './IndexEngine'

// ── Helpers ────────────────────────────────────────────────────────────────────

function makeDoc(text: string): { doc: Y.Doc; ytext: Y.Text } {
  const doc = new Y.Doc()
  doc.gc = false
  const ytext = doc.getText('content')
  ytext.insert(0, text)
  return { doc, ytext }
}

function cloneDoc(source: Y.Doc): Y.Doc {
  const clone = new Y.Doc()
  clone.gc = false
  Y.applyUpdate(clone, Y.encodeStateAsUpdate(source))
  return clone
}

function syncTo(source: Y.Doc, target: Y.Doc): void {
  Y.applyUpdate(target, Y.encodeStateAsUpdate(source, Y.encodeStateVector(target)))
}

// Crée une entrée hashtag manuellement (pour tester le store indépendamment)
function makeHashtagEntry(ytext: Y.Text, docId: string, start: number, end: number, value: string) {
  const a1 = createRelPos(ytext, start, 0)
  const a2 = createRelPos(ytext, end, -1)
  const id = `hashtags|${docId}|${anchorKey(a1)}|${anchorKey(a2)}`
  return { id, namespace: 'hashtags', value, docId, anchor1: a1, anchor2: a2 }
}

// ── S1 — Déterminisme des anchres ─────────────────────────────────────────────

describe('S1 — anchor determinism (central hypothesis)', () => {
  it('two peers anchoring the same token produce the same entry id', () => {
    // Both peers must share the same origin doc — CRDT items carry the clientID
    // of whoever inserted them. Two separate docs → different clientIDs → different anchors.
    const { doc: docA, ytext: ytextA } = makeDoc('hello #salut world')
    const docB = cloneDoc(docA)
    const ytextB = docB.getText('content')

    const eA = makeHashtagEntry(ytextA, 'doc1', 6, 12, '#salut')
    const eB = makeHashtagEntry(ytextB, 'doc1', 6, 12, '#salut')

    expect(eA.id).toBe(eB.id)
    expect(eA.anchor1).toEqual(eB.anchor1)
    expect(eA.anchor2).toEqual(eB.anchor2)
  })

  it('add() with the same id is idempotent — no duplicates', () => {
    const { ytext } = makeDoc('hello #salut world')
    const index = new AnchorIndex()

    const e1 = makeHashtagEntry(ytext, 'doc1', 6, 12, '#salut')
    const e2 = makeHashtagEntry(ytext, 'doc1', 6, 12, '#salut')
    index.add(e1)
    index.add(e2)

    expect(index.getByValue('hashtags', '#salut')).toHaveLength(1)
  })
})

// ── S2 — Insertion avant le token ─────────────────────────────────────────────

describe('S2 — insertion before the token', () => {
  it('anchors remain valid after text is inserted before the hashtag', () => {
    const { doc, ytext } = makeDoc('hello #salut world')
    const entry = makeHashtagEntry(ytext, 'doc1', 6, 12, '#salut')

    ytext.insert(6, 'XXXX ')
    expect(ytext.toString()).toBe('hello XXXX #salut world')

    const resolved = resolveEntry(entry, doc)
    expect(resolved).not.toBeNull()
    expect(resolved!.currentValue).toBe('#salut')
    expect(validateEntry(entry, doc)).toBe('valid')
  })
})

// ── S3 — Insertion dans le token ──────────────────────────────────────────────

describe('S3 — insertion inside the token', () => {
  it('detects invalidation and updates the entry in-place to the new value', () => {
    const { doc, ytext } = makeDoc('hello #salut world')
    const engine = new IndexEngine()
    engine.register(new HashtagContributor())
    engine.onYjsChange(ytext, doc, 'doc1')

    const originalId = engine.index.getByValue('hashtags', '#salut')[0]!.id

    ytext.insert(9, 'X')
    expect(ytext.toString()).toBe('hello #saXlut world')
    engine.onYjsChange(ytext, doc, 'doc1')

    expect(engine.index.getByValue('hashtags', '#salut')).toHaveLength(0)
    expect(engine.index.getByValue('hashtags', '#saXlut')).toHaveLength(1)
    // DECISION: même paire d'anchres (#→t) → même ID → mise à jour in-place
    expect(engine.index.getByDoc('hashtags', 'doc1').find(e => e.id === originalId)?.value).toBe('#saXlut')
  })
})

// ── S4 — Suppression du token ─────────────────────────────────────────────────

describe('S4 — token deletion', () => {
  it('removes the entry when the hashtag is deleted', () => {
    const { doc, ytext } = makeDoc('hello #salut world')
    const engine = new IndexEngine()
    engine.register(new HashtagContributor())
    engine.onYjsChange(ytext, doc, 'doc1')
    expect(engine.index.size).toBe(1)

    ytext.delete(6, 6)
    engine.onYjsChange(ytext, doc, 'doc1')

    expect(engine.index.size).toBe(0)
  })

  it('remove(id) is idempotent', () => {
    const { ytext } = makeDoc('#salut')
    const index = new AnchorIndex()
    const entry = makeHashtagEntry(ytext, 'doc1', 0, 6, '#salut')
    index.add(entry)
    index.remove(entry.id)
    index.remove(entry.id)
    expect(index.size).toBe(0)
  })
})

// ── S5 — Convergence P2P ──────────────────────────────────────────────────────

describe('S5 — P2P convergence after offline edits', () => {
  it('both peers end up with the same index after cross-sync', () => {
    const docA = new Y.Doc(); docA.gc = false
    const docB = cloneDoc(docA)

    const engineA = new IndexEngine(); engineA.register(new HashtagContributor())
    const engineB = new IndexEngine(); engineB.register(new HashtagContributor())

    docA.getText('content').insert(0, '#salut ')
    engineA.onYjsChange(docA.getText('content'), docA, 'doc1')

    docB.getText('content').insert(0, '#todo ')
    engineB.onYjsChange(docB.getText('content'), docB, 'doc1')

    syncTo(docA, docB); syncTo(docB, docA)

    expect(docA.getText('content').toString()).toBe(docB.getText('content').toString())

    engineA.onYjsChange(docA.getText('content'), docA, 'doc1')
    engineB.onYjsChange(docB.getText('content'), docB, 'doc1')

    const idsA = engineA.index.getByDoc('hashtags', 'doc1').map(e => e.id).sort()
    const idsB = engineB.index.getByDoc('hashtags', 'doc1').map(e => e.id).sort()
    expect(idsA).toEqual(idsB)
    expect(engineA.index.getByValue('hashtags', '#salut')).toHaveLength(1)
    expect(engineA.index.getByValue('hashtags', '#todo')).toHaveLength(1)
  })
})

// ── S6 — Détection du staleness ───────────────────────────────────────────────

describe('S6 — staleness detection on vault snapshot', () => {
  it('flags a doc with entries when server updatedAt is newer than lastValidatedAt', () => {
    const { doc, ytext } = makeDoc('#salut')
    const engine = new IndexEngine()
    engine.register(new HashtagContributor())
    engine.onYjsChange(ytext, doc, 'doc1')

    engine.index.checkStaleness('doc1', Date.now() + 10_000)
    expect(engine.index.revalidationQueue.has('doc1')).toBe(true)
  })

  it('does not flag a doc with no index entries', () => {
    const index = new AnchorIndex()
    index.checkStaleness('doc2', Date.now() + 10_000)
    expect(index.revalidationQueue.has('doc2')).toBe(false)
  })

  it('clears the flag after revalidation', () => {
    const { doc, ytext } = makeDoc('#salut')
    const engine = new IndexEngine()
    engine.register(new HashtagContributor())
    engine.onYjsChange(ytext, doc, 'doc1')

    engine.index.checkStaleness('doc1', Date.now() + 10_000)
    expect(engine.index.revalidationQueue.has('doc1')).toBe(true)

    engine.onYjsChange(ytext, doc, 'doc1')
    expect(engine.index.revalidationQueue.has('doc1')).toBe(false)
  })
})
