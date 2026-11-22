// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Annotations dans le document : un fil se retrouve par son identifiant (ou
// par celui d'une reponse), et un commentaire de plugin garde ce qu'il vise.
import { describe, it, expect, afterEach } from 'vitest'
import { ReviewService, type IVaultSyncSession, type UserActor } from '@savoire/application'
import { InProcessPeerBus, LocalPeerVaultSessionFactory } from '@savoire/infrastructure-sync'

const SETTLE_MS = 5
const settle = () => new Promise(r => setTimeout(r, SETTLE_MS * 4))
const alice: UserActor = { kind: 'user', userId: 'alice', displayName: 'Alice' }
const bob: UserActor = { kind: 'user', userId: 'bob', displayName: 'Bob' }

describe('ReviewService : annotations', () => {
  const sessions: IVaultSyncSession[] = []
  afterEach(async () => { for (const s of sessions.splice(0)) await s.dispose() })

  async function setup() {
    const factory = new LocalPeerVaultSessionFactory(new InProcessPeerBus(), { settleMs: SETTLE_MS })
    const open = async (userId: string) => {
      const s = await factory.open({ vaultId: 'v1', token: '', userId, onChanged: () => {} })
      sessions.push(s)
      let t = Date.parse('2026-11-22T10:00:00Z')
      return new ReviewService(s, () => new Date(t += 1000))
    }
    return { a: await open('alice'), b: await open('bob') }
  }

  it('thread() rend le fil, par la racine ou par une reponse', async () => {
    const { a } = await setup()
    const root = a.comment('d1', 'A revoir', alice)
    const r1 = a.reply(root.id, 'Fait', bob)
    a.reply(root.id, 'Merci', alice)
    const byRoot = a.thread(root.id)!
    expect(byRoot.root.id).toBe(root.id)
    expect(byRoot.replies.map(r => r.text)).toEqual(['Fait', 'Merci'])
    expect(a.thread(r1.id)!.root.id).toBe(root.id)
    expect(a.thread('inconnu')).toBeUndefined()
  })

  it('un commentaire de plugin garde sa cible, chez tous les membres', async () => {
    const { a, b } = await setup()
    const target = { row: 'r1', column: 'Statut' }
    const c = a.comment('base1', 'Valeur douteuse', alice, undefined, target)
    await settle()
    const seen = b.thread(c.id)!.root
    expect(seen.target).toEqual(target)
    expect(seen.anchor).toBeUndefined()
  })

  it('une cible qui n\'est pas du JSON, ou trop grosse, est refusee', async () => {
    const { a } = await setup()
    expect(() => a.comment('d1', 'x', alice, undefined, () => 1)).toThrow(/cible/)
    expect(() => a.comment('d1', 'x', alice, undefined, { big: 'x'.repeat(20 * 1024) })).toThrow(/trop grosse/)
  })

  it('sans cible, un commentaire n\'en porte pas', async () => {
    const { a } = await setup()
    const c = a.comment('d1', 'Note entiere', alice)
    expect('target' in a.thread(c.id)!.root).toBe(false)
  })
})
