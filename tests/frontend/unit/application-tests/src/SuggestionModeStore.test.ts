// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Le mode suggestion suit le compte, d'un appareil a l'autre, dans un vault.
import { describe, it, expect } from 'vitest'
import { SuggestionModeStore } from '@savoire/application'
import { MemChannel } from './helpers/memChannel'

/** Deux appareils (ou deux membres) relies sur le meme vault. */
function devices() {
  const a = new MemChannel(), b = new MemChannel()
  MemChannel.link(a, b)
  const session = (c: MemChannel) => ({ openSharedMap: (name: string) => { expect(name).toBe('review-mode'); return c } })
  return { a: session(a), b: session(b) }
}

describe('SuggestionModeStore', () => {
  it('eteint par defaut', () => {
    expect(new SuggestionModeStore(devices().a, 'alice').get()).toBe(false)
  })

  it('suit le compte sur un autre appareil, en direct', () => {
    const { a, b } = devices()
    const pc = new SuggestionModeStore(a, 'alice')
    const phone = new SuggestionModeStore(b, 'alice')
    const seen: boolean[] = []
    phone.onChange(on => seen.push(on))
    pc.set(true)
    expect(phone.get()).toBe(true)
    pc.set(false)
    expect(seen).toEqual([true, false])
  })

  it('le mode d un autre compte ne bouge pas', () => {
    const { a, b } = devices()
    const alice = new SuggestionModeStore(a, 'alice')
    const bob = new SuggestionModeStore(b, 'bob')
    const seen: boolean[] = []
    bob.onChange(on => seen.push(on))
    alice.set(true)
    expect(bob.get()).toBe(false)
    expect(seen).toEqual([])
  })
})
