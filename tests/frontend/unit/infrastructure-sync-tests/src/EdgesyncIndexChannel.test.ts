// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// EdgesyncIndexChannel: a plain Y.Map<entryId, value> wrapper. This file only
// tests the local Map-like API and change notifications in isolation — the
// actual CRDT sync (through Session/Keyring, converging across peers,
// catching up a late joiner) is proven in EdgesyncVaultSession.test.ts, since
// that's where two real Y.Docs actually get wired together.
import { describe, it, expect } from 'vitest'
import { EdgesyncIndexChannel } from '@savoire/infrastructure-sync'

describe('EdgesyncIndexChannel', () => {
  it('set/get/getAll/delete se comportent comme un dictionnaire', () => {
    const ch = new EdgesyncIndexChannel()

    ch.set('hashtags|doc-1|a|b', { value: '#salut', docId: 'doc-1' })
    ch.set('hashtags|doc-2|c|d', { value: '#coucou', docId: 'doc-2' })

    expect(ch.get('hashtags|doc-1|a|b')).toEqual({ value: '#salut', docId: 'doc-1' })
    expect(ch.getAll()).toHaveLength(2)

    ch.delete('hashtags|doc-1|a|b')
    expect(ch.get('hashtags|doc-1|a|b')).toBeUndefined()
    expect(ch.getAll()).toHaveLength(1)
  })

  it('set() sur la meme clef remplace entierement la valeur (pas de fusion)', () => {
    const ch = new EdgesyncIndexChannel()
    ch.set('k', { tags: ['a', 'b'] })
    ch.set('k', { tags: ['c'] }) // remplacement complet, pas d'union avec l'ancienne valeur

    expect(ch.get('k')).toEqual({ tags: ['c'] })
  })

  it('onChange notifie les clefs modifiees (ajout, mise a jour, suppression)', () => {
    const ch = new EdgesyncIndexChannel()
    const changes: string[][] = []
    ch.onChange((ids) => changes.push(ids))

    ch.set('a', 1)
    ch.set('b', 2)
    ch.set('a', 3) // update
    ch.delete('b')

    expect(changes).toEqual([['a'], ['b'], ['a'], ['b']])
  })

  it('onChange : le desabonnement arrete les notifications', () => {
    const ch = new EdgesyncIndexChannel()
    const changes: string[][] = []
    const unsub = ch.onChange((ids) => changes.push(ids))

    ch.set('a', 1)
    unsub()
    ch.set('b', 2)

    expect(changes).toEqual([['a']])
  })
})
