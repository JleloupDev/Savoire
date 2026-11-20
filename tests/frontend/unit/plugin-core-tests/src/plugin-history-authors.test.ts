// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Auteur des versions dans une note partagee : ce qu'un invite (lien de
// partage) modifie est enregistre a son nom, « Invité », par les membres qui
// le voient arriver ; ce qu'un autre ecrit ne se melange jamais a ce qu'on a
// tape sous notre nom.
import { describe, it, expect } from 'vitest'
import type { ISharedMap } from '@savoire/plugin-api'
import { VersionRecorder, listVersions, authorLabel, GUEST_SETTLE_MS } from '@savoire/plugin-history'

function memoryMap(): ISharedMap {
  const data = new Map<string, unknown>()
  return {
    set: (k, v) => { data.set(k, v) },
    delete: k => { data.delete(k) },
    getAll: () => [...data].map(([id, value]) => ({ id, value })),
    onChange: () => () => {},
  }
}

const guest = { id: 'share:lien-1', name: 'Invité', guest: true }
const bob = { id: 'bob', name: 'Bob', guest: false }

function setup(map = memoryMap(), name = 'Ana') {
  let now = Date.UTC(2026, 10, 16, 9, 0)
  const recorder = new VersionRecorder({ openMap: () => map, me: () => ({ id: name.toLowerCase(), name }), now: () => now })
  return { map, recorder, advance: (ms: number) => { now += ms } }
}

const authors = (map: ISharedMap) => listVersions(map).map(v => [v.author?.name ?? null, v.text])

describe('versions : auteurs dans une note partagee', () => {
  it('les modifications d un invite sont enregistrees a son nom, Invité', () => {
    const { map, recorder, advance } = setup()
    recorder.observe('d', 'texte', false)
    recorder.observe('d', 'texte + invite', false, [guest])
    expect(listVersions(map).map(v => v.text)).toEqual(['texte'], 'le texte d avant est garde')
    advance(GUEST_SETTLE_MS); recorder.tick()
    expect(authors(map)).toEqual([['Invité', 'texte + invite'], [null, 'texte']])
    expect(listVersions(map)[0].author?.guest).toBe(true)
  })

  it('ce qu on a tape n est jamais attribue avec ce qu ecrit un invite', () => {
    const { map, recorder } = setup()
    recorder.observe('d', 'base', false)
    recorder.observe('d', 'base + Ana', true)
    recorder.observe('d', 'base + Ana + invite', false, [guest])
    recorder.observe('d', 'base + Ana + invite + Ana', true)
    recorder.flush()
    expect(authors(map)).toEqual([
      ['Ana', 'base + Ana + invite + Ana'],
      ['Invité', 'base + Ana + invite'],
      ['Ana', 'base + Ana'],
      [null, 'base'],
    ])
  })

  it('ce qu ecrit un membre n est pas enregistre ici, et ne se melange pas au notre', () => {
    const { map, recorder } = setup()
    recorder.observe('d', 'base', false)
    recorder.observe('d', 'base + Ana', true)
    recorder.observe('d', 'base + Ana + Bob', false, [bob])
    recorder.flush()
    expect(authors(map)).toEqual([['Ana', 'base + Ana'], [null, 'base']])
  })

  it('deux membres voient la meme modification d un invite : une seule version', () => {
    const map = memoryMap()
    const a = setup(map, 'Ana'), b = setup(map, 'Bob')
    for (const s of [a, b]) { s.recorder.observe('d', 'base', false); s.recorder.observe('d', 'base + invite', false, [guest]) }
    a.recorder.flush(); b.recorder.flush()
    expect(authors(map)).toEqual([['Invité', 'base + invite'], [null, 'base']])
  })

  it('plusieurs invites : Invités', () => {
    const { map, recorder } = setup()
    recorder.observe('d', 'x', false)
    recorder.observe('d', 'x1', false, [guest])
    recorder.observe('d', 'x12', false, [{ id: 'share:lien-2', name: 'Invité', guest: true }])
    recorder.flush()
    expect(listVersions(map)[0].author?.name).toBe('Invités')
  })

  it('un agent IA ecrit : « Nom (IA), pour Personne », tel que le serveur le declare', () => {
    const { map, recorder, advance } = setup()
    // Ce que le serveur joint a l'operation d'un agent (backend/src/api/agents.rs).
    const editors = [{ id: 'agent:a1:bob', name: 'Bob', guest: false, agentId: 'a1', agentName: 'Relectrice' }]
    recorder.observe('d', 'texte', false)
    recorder.observe('d', 'texte corrige', false, editors)
    advance(GUEST_SETTLE_MS); recorder.tick()
    const v = listVersions(map)[0]
    expect(v.text).toBe('texte corrige')
    expect(authorLabel(v.author)).toBe('Relectrice (IA), pour Bob')
    expect(authorLabel({ id: 'bob', name: 'Bob' })).toBe('Bob')
  })
})
