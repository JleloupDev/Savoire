// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { YMapVaultDirectory } from '@savoire/infrastructure-sync'
import type { IDocumentMeta } from '@savoire/platform'

// ── Helpers ───────────────────────────────────────────────────────────────────

function doc(id: string, path: string): IDocumentMeta {
  return { id, path }
}

/**
 * Creates two wired YMapVaultDirectory instances.
 * wire()  → incremental sync: each local update is immediately forwarded to the peer.
 * fullSync() → full-state exchange: both apply each other's complete encoded state.
 */
function makePair() {
  const a = new YMapVaultDirectory()
  const b = new YMapVaultDirectory()

  return {
    a,
    b,
    wire(): () => void {
      const u1 = a.onLocalUpdate(op => b.applyUpdate(op))
      const u2 = b.onLocalUpdate(op => a.applyUpdate(op))
      return () => { u1(); u2() }
    },
    fullSync() {
      b.applyUpdate(a.encodeFullState())
      a.applyUpdate(b.encodeFullState())
    },
  }
}

// ── Group 1 — Single instance: basic mutations ────────────────────────────────

describe('YMapVaultDirectory — basic mutations', () => {
  let dir: YMapVaultDirectory

  beforeEach(() => { dir = new YMapVaultDirectory() })
  afterEach(() => dir.dispose())

  it('starts empty', () => {
    expect(dir.getAll()).toHaveLength(0)
  })

  it('add() makes doc visible in getAll()', () => {
    dir.add(doc('a', 'note.md'))
    expect(dir.getAll()).toEqual([doc('a', 'note.md')])
  })

  it('add() same id twice does not duplicate', () => {
    dir.add(doc('a', 'note.md'))
    dir.add(doc('a', 'note.md'))
    expect(dir.getAll()).toHaveLength(1)
  })

  it('getById() returns doc when present', () => {
    dir.add(doc('a', 'note.md'))
    expect(dir.getById('a')).toEqual(doc('a', 'note.md'))
  })

  it('getById() returns undefined when absent', () => {
    expect(dir.getById('missing')).toBeUndefined()
  })

  it('remove() removes existing doc', () => {
    dir.add(doc('a', 'note.md'))
    dir.remove('a')
    expect(dir.getAll()).toHaveLength(0)
  })

  it('remove() on unknown id is a no-op', () => {
    dir.add(doc('a', 'note.md'))
    expect(() => dir.remove('missing')).not.toThrow()
    expect(dir.getAll()).toHaveLength(1)
  })

  it('rename() updates path', () => {
    dir.add(doc('a', 'old.md'))
    dir.rename('a', 'new.md')
    expect(dir.getById('a')?.path).toBe('new.md')
  })

  it('rename() on unknown id is a no-op', () => {
    expect(() => dir.rename('missing', 'x.md')).not.toThrow()
  })

  it('applyServerState() replaces entire state', () => {
    dir.add(doc('x', 'x.md'))
    dir.applyServerState([doc('a', 'a.md'), doc('b', 'b.md')])
    const all = dir.getAll()
    expect(all).toHaveLength(2)
    expect(all.map(d => d.id).sort()).toEqual(['a', 'b'])
  })

  it('applyServerState([]) empties the directory', () => {
    dir.add(doc('a', 'note.md'))
    dir.applyServerState([])
    expect(dir.getAll()).toHaveLength(0)
  })

  it('applyServerState() is idempotent for same data', () => {
    const docs = [doc('a', 'a.md'), doc('b', 'b.md')]
    dir.applyServerState(docs)
    dir.applyServerState(docs)
    expect(dir.getAll()).toHaveLength(2)
  })
})

// ── Group 2 — Origin filtering ────────────────────────────────────────────────

describe('YMapVaultDirectory — origin filtering', () => {
  let dir: YMapVaultDirectory
  const localUpdates: Uint8Array[] = []
  const changeCount: { n: number } = { n: 0 }
  let unsubLocal: () => void
  let unsubChange: () => void

  beforeEach(() => {
    dir = new YMapVaultDirectory()
    localUpdates.length = 0
    changeCount.n = 0
    unsubLocal = dir.onLocalUpdate(u => localUpdates.push(u))
    unsubChange = dir.onChange(() => changeCount.n++)
  })

  afterEach(() => {
    unsubLocal()
    unsubChange()
    dir.dispose()
  })

  it('add() fires onLocalUpdate', () => {
    dir.add(doc('a', 'note.md'))
    expect(localUpdates).toHaveLength(1)
  })

  it('remove() fires onLocalUpdate', () => {
    dir.add(doc('a', 'note.md'))
    localUpdates.length = 0
    dir.remove('a')
    expect(localUpdates).toHaveLength(1)
  })

  it('rename() fires onLocalUpdate', () => {
    dir.add(doc('a', 'old.md'))
    localUpdates.length = 0
    dir.rename('a', 'new.md')
    expect(localUpdates).toHaveLength(1)
  })

  it('applyServerState() does NOT fire onLocalUpdate', () => {
    dir.applyServerState([doc('a', 'note.md')])
    expect(localUpdates).toHaveLength(0)
  })

  it('applyUpdate() does NOT fire onLocalUpdate', () => {
    const remote = new YMapVaultDirectory()
    remote.add(doc('r', 'remote.md'))
    const state = remote.encodeFullState()
    remote.dispose()

    dir.applyUpdate(state)
    expect(localUpdates).toHaveLength(0)
  })

  it('add() fires onChange', () => {
    dir.add(doc('a', 'note.md'))
    expect(changeCount.n).toBeGreaterThan(0)
  })

  it('applyServerState() fires onChange', () => {
    dir.applyServerState([doc('a', 'note.md')])
    expect(changeCount.n).toBeGreaterThan(0)
  })

  it('applyUpdate() fires onChange', () => {
    const remote = new YMapVaultDirectory()
    remote.add(doc('r', 'remote.md'))
    const state = remote.encodeFullState()
    remote.dispose()

    dir.applyUpdate(state)
    expect(changeCount.n).toBeGreaterThan(0)
  })

  it('onChange unsubscribe stops notifications', () => {
    unsubChange()
    changeCount.n = 0
    dir.add(doc('z', 'z.md'))
    expect(changeCount.n).toBe(0)
  })

  it('onLocalUpdate unsubscribe stops notifications', () => {
    unsubLocal()
    localUpdates.length = 0
    dir.add(doc('z', 'z.md'))
    expect(localUpdates).toHaveLength(0)
  })
})

// ── Group 3 — Multi-instance convergence (real Yjs) ───────────────────────────

describe('YMapVaultDirectory — multi-instance convergence', () => {
  it('join: B applies A full state and sees all docs', () => {
    const { a, b, fullSync } = makePair()

    a.add(doc('1', 'alpha.md'))
    a.add(doc('2', 'beta.md'))
    a.add(doc('3', 'gamma.md'))

    b.applyUpdate(a.encodeFullState())

    expect(b.getAll().map(d => d.id).sort()).toEqual(['1', '2', '3'])

    a.dispose(); b.dispose()
    void fullSync // satisfy linter
  })

  it('incremental sync: A adds doc → B receives it', () => {
    const { a, b, wire } = makePair()
    const unwire = wire()

    a.add(doc('x', 'x.md'))
    expect(b.getById('x')).toEqual(doc('x', 'x.md'))

    unwire(); a.dispose(); b.dispose()
  })

  it('incremental sync: A removes doc → B removes it too', () => {
    const { a, b, wire } = makePair()
    const unwire = wire()

    a.add(doc('x', 'x.md'))
    expect(b.getById('x')).toBeDefined()

    a.remove('x')
    expect(b.getById('x')).toBeUndefined()

    unwire(); a.dispose(); b.dispose()
  })

  it('incremental sync: A renames doc → B sees new path', () => {
    const { a, b, wire } = makePair()
    const unwire = wire()

    a.add(doc('x', 'old.md'))
    a.rename('x', 'new.md')
    expect(b.getById('x')?.path).toBe('new.md')

    unwire(); a.dispose(); b.dispose()
  })

  it('concurrent adds converge: both instances see both docs after fullSync', () => {
    const { a, b, fullSync } = makePair()

    // No wiring — isolated mutations
    a.add(doc('a-doc', 'from-a.md'))
    b.add(doc('b-doc', 'from-b.md'))

    fullSync()

    const aIds = a.getAll().map(d => d.id).sort()
    const bIds = b.getAll().map(d => d.id).sort()
    expect(aIds).toEqual(['a-doc', 'b-doc'])
    expect(bIds).toEqual(['a-doc', 'b-doc'])

    a.dispose(); b.dispose()
  })

  it('concurrent rename: both converge to same path (Yjs LWW)', () => {
    const { a, b, wire, fullSync } = makePair()
    const unwire = wire()

    // Seed both with same doc
    a.add(doc('shared', 'original.md'))
    // a→b sync already propagated via wire

    unwire() // isolate

    a.rename('shared', 'from-a.md')
    b.rename('shared', 'from-b.md')

    fullSync()

    // Both must have converged to the same path (either value, but identical)
    const pathA = a.getById('shared')?.path
    const pathB = b.getById('shared')?.path
    expect(pathA).toBe(pathB)
    expect(['from-a.md', 'from-b.md']).toContain(pathA)

    a.dispose(); b.dispose()
  })

  it('concurrent rename + delete: Yjs converges (set wins — new item survives tombstone)', () => {
    const { a, b, wire, fullSync } = makePair()
    const unwire = wire()

    // Seed: both know doc 'z'
    a.add(doc('z', 'z.md'))
    // b also has it via wire

    unwire() // isolate

    // A renames, B deletes
    a.rename('z', 'z-renamed.md')
    b.remove('z')

    fullSync()

    // In Yjs YMap, a concurrent set creates a NEW item while delete tombstones
    // the old one — the new item from the rename survives on both peers.
    const pathA = a.getById('z')?.path
    const pathB = b.getById('z')?.path
    expect(pathA).toBe('z-renamed.md')
    expect(pathB).toBe('z-renamed.md')

    a.dispose(); b.dispose()
  })

  it('idempotency: applying same update twice has no side-effect', () => {
    const { a, b } = makePair()

    a.add(doc('dup', 'dup.md'))
    const update = a.encodeFullState()

    b.applyUpdate(update)
    b.applyUpdate(update) // second application

    expect(b.getAll()).toHaveLength(1)
    expect(b.getById('dup')).toEqual(doc('dup', 'dup.md'))

    a.dispose(); b.dispose()
  })

  it('commutativity: sync order does not affect final state', () => {
    const a = new YMapVaultDirectory()
    const b = new YMapVaultDirectory()
    const c = new YMapVaultDirectory()

    a.add(doc('a1', 'a1.md'))
    b.add(doc('b1', 'b1.md'))

    // Apply in different orders on c
    c.applyUpdate(b.encodeFullState())
    c.applyUpdate(a.encodeFullState())

    const d = new YMapVaultDirectory()
    d.applyUpdate(a.encodeFullState())
    d.applyUpdate(b.encodeFullState())

    const cIds = c.getAll().map(x => x.id).sort()
    const dIds = d.getAll().map(x => x.id).sort()
    expect(cIds).toEqual(dIds)

    a.dispose(); b.dispose(); c.dispose(); d.dispose()
  })

  it('re-convergence: 5 isolated mutations on each side merge correctly', () => {
    const { a, b, fullSync } = makePair()

    for (let i = 0; i < 5; i++) a.add(doc(`a-${i}`, `a-${i}.md`))
    for (let i = 0; i < 5; i++) b.add(doc(`b-${i}`, `b-${i}.md`))

    fullSync()

    const aCount = a.getAll().length
    const bCount = b.getAll().length
    expect(aCount).toBe(10)
    expect(bCount).toBe(10)

    // Both see the same set
    const aIds = a.getAll().map(d => d.id).sort()
    const bIds = b.getAll().map(d => d.id).sort()
    expect(aIds).toEqual(bIds)

    a.dispose(); b.dispose()
  })

  it('three-way convergence: A, B, C all isolate then sync pairwise', () => {
    const a = new YMapVaultDirectory()
    const b = new YMapVaultDirectory()
    const c = new YMapVaultDirectory()

    a.add(doc('a1', 'a.md'))
    b.add(doc('b1', 'b.md'))
    c.add(doc('c1', 'c.md'))

    // Sync: A←→B, B←→C, then A←→C
    b.applyUpdate(a.encodeFullState()); a.applyUpdate(b.encodeFullState())
    c.applyUpdate(b.encodeFullState()); b.applyUpdate(c.encodeFullState())
    a.applyUpdate(c.encodeFullState()); c.applyUpdate(a.encodeFullState())

    const expected = ['a1', 'b1', 'c1']
    for (const inst of [a, b, c]) {
      expect(inst.getAll().map(d => d.id).sort()).toEqual(expected)
    }

    a.dispose(); b.dispose(); c.dispose()
  })

  it('encodeFullState on empty directory produces valid (applicable) update', () => {
    const { a, b } = makePair()

    const empty = a.encodeFullState()
    expect(() => b.applyUpdate(empty)).not.toThrow()

    a.dispose(); b.dispose()
  })
})
