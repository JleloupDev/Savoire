// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// GracePool: effect remounts must reuse the SAME live resource (the key-holder
// session survives churn); real disposal only happens after the grace period.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { GracePool } from '@savoire/infrastructure-sync'

interface Res { id: number }

describe('GracePool', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  function make(graceMs = 1000) {
    const disposed: Res[] = []
    let next = 0
    const pool = new GracePool<Res>((r) => disposed.push(r), graceMs)
    const create = () => ({ id: next++ })
    return { pool, create, disposed }
  }

  it('remount rapide : la meme instance est reutilisee, rien n\'est dispose', () => {
    const { pool, create, disposed } = make()
    const l1 = pool.acquire('k', create)
    l1.release() // unmount (StrictMode)
    const l2 = pool.acquire('k', create) // remount dans la periode de grace
    expect(l2.value).toBe(l1.value)
    vi.advanceTimersByTime(5000)
    expect(disposed).toEqual([]) // toujours tenu par l2
  })

  it('sans re-acquisition, dispose apres la grace seulement', () => {
    const { pool, create, disposed } = make(1000)
    const l1 = pool.acquire('k', create)
    l1.release()
    vi.advanceTimersByTime(999)
    expect(disposed).toEqual([])
    vi.advanceTimersByTime(1)
    expect(disposed).toEqual([l1.value])
    // une nouvelle acquisition recree une instance neuve
    const l2 = pool.acquire('k', create)
    expect(l2.value).not.toBe(l1.value)
  })

  it('double release d\'un meme lease ne decompte qu\'une fois', () => {
    const { pool, create, disposed } = make(1000)
    const l1 = pool.acquire('k', create)
    const l2 = pool.acquire('k', create)
    l1.release()
    l1.release() // double release du meme lease : ignore
    vi.advanceTimersByTime(2000)
    expect(disposed).toEqual([]) // l2 tient toujours
    l2.release()
    vi.advanceTimersByTime(1000)
    expect(disposed).toEqual([l2.value])
  })

  it('evict : l\'entree cassee est abandonnee sans dispose, la suivante recree', () => {
    const { pool, create, disposed } = make()
    const l1 = pool.acquire('k', create)
    pool.evict('k', l1.value)
    const l2 = pool.acquire('k', create)
    expect(l2.value).not.toBe(l1.value)
    expect(disposed).toEqual([])
    // evict conditionnel : ne supprime pas si la valeur ne correspond plus
    pool.evict('k', l1.value)
    const l3 = pool.acquire('k', create)
    expect(l3.value).toBe(l2.value)
  })

  it('cles distinctes = ressources distinctes', () => {
    const { pool, create } = make()
    const a = pool.acquire('a', create)
    const b = pool.acquire('b', create)
    expect(a.value).not.toBe(b.value)
  })
})
