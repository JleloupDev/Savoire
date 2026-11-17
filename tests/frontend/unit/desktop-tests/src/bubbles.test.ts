// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// Bulles : une liste par compte et par vault, gardee d'une session a l'autre,
// une seule bulle ouverte a la fois.
import { describe, it, expect } from 'vitest'
import { BubbleStore, MAX_BUBBLES } from '../../../../../apps/web/src/bubbles'

function memoryStorage() {
  const data = new Map<string, string>()
  return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => { data.set(k, v) } }
}

describe('bulles', () => {
  it('une liste par compte et par vault, gardee', () => {
    const storage = memoryStorage()
    const a = new BubbleStore(storage)
    a.setScope('u1', 'v1')
    a.add('d1', 'equipe.chat')
    a.add('d2', 'Plan.md')
    a.add('d1', 'equipe.chat')
    expect(a.list().map(b => b.docId)).toEqual(['d1', 'd2'])
    a.setScope('u1', 'v2')
    expect(a.list()).toEqual([])
    const again = new BubbleStore(storage)
    again.setScope('u1', 'v1')
    expect(again.list().map(b => b.path)).toEqual(['equipe.chat', 'Plan.md'])
  })

  it('une seule ouverte a la fois ; retirer la referme', () => {
    const s = new BubbleStore(memoryStorage())
    s.setScope('u', 'v')
    s.add('d1', 'a.chat'); s.add('d2', 'b.md', true)
    expect(s.opened()).toBe('d2')
    s.toggle('d1')
    expect(s.opened()).toBe('d1')
    s.toggle('d1')
    expect(s.opened()).toBeNull()
    s.toggle('d2'); s.remove('d2')
    expect(s.opened()).toBeNull()
    expect(s.list().map(b => b.docId)).toEqual(['d1'])
  })

  it('au plus MAX_BUBBLES : la plus ancienne part ; sans vault, rien', () => {
    const s = new BubbleStore(memoryStorage())
    s.add('x', 'x.md')
    expect(s.list()).toEqual([])
    s.setScope('u', 'v')
    for (let i = 0; i <= MAX_BUBBLES; i++) s.add(`d${i}`, `${i}.md`)
    expect(s.list()).toHaveLength(MAX_BUBBLES)
    expect(s.has('d0')).toBe(false)
  })

  it('previent ses abonnes', () => {
    const s = new BubbleStore(memoryStorage())
    let calls = 0
    s.subscribe(() => { calls++ })
    s.setScope('u', 'v'); s.add('d', 'd.md'); s.toggle('d'); s.close(); s.remove('d')
    expect(calls).toBe(5)
  })
})
