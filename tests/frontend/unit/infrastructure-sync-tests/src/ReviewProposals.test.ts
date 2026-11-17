// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Propositions de modification des autres types de documents (base, dessin,
// LaTeX...) : elles voyagent comme les commentaires, entre deux pairs du
// connecteur local, et ne changent rien tant qu'on ne les accepte pas.
import { describe, it, expect, afterEach } from 'vitest'
import { ReviewService, type IVaultSyncSession, type UserActor } from '@savoire/application'
import { InProcessPeerBus, LocalPeerVaultSessionFactory } from '@savoire/infrastructure-sync'

const SETTLE_MS = 5
const settle = () => new Promise(r => setTimeout(r, SETTLE_MS * 4))
const alice: UserActor = { kind: 'user', userId: 'alice', displayName: 'Alice' }
const bob: UserActor = { kind: 'user', userId: 'bob', displayName: 'Bob' }

describe('ReviewService : propositions des plugins', () => {
  const sessions: IVaultSyncSession[] = []
  afterEach(async () => { for (const s of sessions.splice(0)) await s.dispose() })

  async function setup() {
    const factory = new LocalPeerVaultSessionFactory(new InProcessPeerBus(), { settleMs: SETTLE_MS })
    const open = async (userId: string) => {
      const s = await factory.open({ vaultId: 'v1', token: '', userId, onChanged: () => {} })
      sessions.push(s)
      let t = Date.parse('2026-11-17T10:00:00Z')
      return new ReviewService(s, () => new Date(t += 1000))
    }
    return { a: await open('alice'), b: await open('bob') }
  }

  it('une proposition arrive chez l\'autre membre, ouverte, avec son type et son contenu', async () => {
    const { a, b } = await setup()
    const payload = { row: { kind: 'page', docId: 'n1' }, title: 'Tache', key: 'Statut', before: 'En cours', after: 'Fait' }
    a.propose('base1', 'base.cell', payload, alice, 'A valider')
    await settle()
    const [t] = b.threads('base1')
    expect(t.root).toMatchObject({ kind: 'proposal', proposalType: 'base.cell', status: 'open', text: 'A valider', payload })
  })

  it('accepter (une fois appliquee par son plugin) la ferme, chez tous ; pas deux fois', async () => {
    const { a, b } = await setup()
    const p = a.propose('dessin', 'excalidraw.scene', { elements: [], base: {} }, alice)
    await settle()
    b.markApplied(p.id, bob)
    await settle()
    expect(a.threads('dessin')[0].root).toMatchObject({ status: 'accepted', statusBy: bob })
    expect(() => a.markApplied(p.id, alice)).toThrow(/deja traitee/)
  })

  it('refuser passe par le statut, comme une suggestion', async () => {
    const { a } = await setup()
    const p = a.propose('t.tex', 'savoire.text', { at: 0, before: 'a', after: 'b' }, alice)
    a.setStatus(p.id, 'rejected', bob)
    expect(a.threads('t.tex')[0].root.status).toBe('rejected')
    expect(() => a.markApplied(p.id, bob)).toThrow()
  })

  it('refuse un type mal forme, un contenu non JSON ou trop gros', async () => {
    const { a } = await setup()
    expect(() => a.propose('d', 'sans-point', {}, alice)).toThrow(/type/)
    expect(() => a.propose('d', 'Base.Cell', {}, alice)).toThrow(/type/)
    expect(() => a.propose('d', 'base.cell', undefined, alice)).toThrow()
    const loop: Record<string, unknown> = {}
    loop.self = loop
    expect(() => a.propose('d', 'base.cell', loop, alice)).toThrow(/JSON/)
    expect(() => a.propose('d', 'base.cell', { big: 'x'.repeat(300 * 1024) }, alice)).toThrow(/trop grosse/)
  })
})
