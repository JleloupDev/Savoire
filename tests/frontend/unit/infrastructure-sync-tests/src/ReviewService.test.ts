// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Fils de discussion et statuts de la couche de revision, entre deux pairs
// du connecteur local (sans serveur).
import { describe, it, expect, afterEach } from 'vitest'
import { ReviewService, describeActor, type IVaultSyncSession, type UserActor } from '@savoire/application'
import { InProcessPeerBus, LocalPeerVaultSessionFactory } from '@savoire/infrastructure-sync'

const SETTLE_MS = 5
const settle = () => new Promise(r => setTimeout(r, SETTLE_MS * 4))
const alice: UserActor = { kind: 'user', userId: 'alice', displayName: 'Alice' }
const bob: UserActor = { kind: 'user', userId: 'bob', displayName: 'Bob' }

describe('ReviewService : fils et statuts', () => {
  const sessions: IVaultSyncSession[] = []
  afterEach(async () => { for (const s of sessions.splice(0)) await s.dispose() })

  async function setup() {
    const factory = new LocalPeerVaultSessionFactory(new InProcessPeerBus(), { settleMs: SETTLE_MS })
    const open = async (userId: string) => {
      const s = await factory.open({ vaultId: 'v1', token: '', userId, onChanged: () => {} })
      sessions.push(s)
      // Horloge qui avance : l'ordre des entrees est deterministe.
      let t = Date.parse('2026-10-08T10:00:00Z')
      return new ReviewService(s, () => new Date(t += 1000))
    }
    return { a: await open('alice'), b: await open('bob') }
  }

  it('un commentaire ouvre un fil, ouvert par defaut', async () => {
    const { a } = await setup()
    a.comment('d1', 'Titre trop long', alice)
    const [thread] = a.threads('d1')
    expect(thread.root.status).toBe('open')
    expect(thread.replies).toEqual([])
  })

  it('les reponses de deux membres arrivent dans le meme fil, sans s\'ecraser', async () => {
    const { a, b } = await setup()
    const root = a.comment('d1', 'Titre trop long', alice)
    await settle()
    a.reply(root.id, 'Je propose « Bilan »', alice)
    b.reply(root.id, 'D\'accord', bob)
    await settle()
    for (const svc of [a, b]) {
      const [thread] = svc.threads('d1')
      expect(thread.replies.map(r => describeActor(r.author)).sort()).toEqual(['Alice', 'Bob'])
    }
  })

  it('repondre a une reponse rattache au meme fil', async () => {
    const { a } = await setup()
    const root = a.comment('d1', 'Question', alice)
    const first = a.reply(root.id, 'Reponse', alice)
    a.reply(first.id, 'Precision', alice)
    expect(a.threads('d1')).toHaveLength(1)
    expect(a.threads('d1')[0].replies.map(r => r.text)).toEqual(['Reponse', 'Precision'])
  })

  it('un statut change par un membre se voit chez l\'autre, avec son auteur', async () => {
    const { a, b } = await setup()
    const root = a.comment('d1', 'Faute ligne 3', alice)
    await settle()
    b.setStatus(root.id, 'resolved', bob)
    await settle()
    const [thread] = a.threads('d1')
    expect(thread.root.status).toBe('resolved')
    expect(thread.root.statusBy).toEqual(bob)
    expect(thread.root.text).toBe('Faute ligne 3')
  })

  it('un fil introuvable ou une trace d\'ecriture n\'ont pas de statut a changer', async () => {
    const { a } = await setup()
    expect(() => a.reply('inconnu', 'x', alice)).toThrow('introuvable')
    const edit = a.recordEdit('d1', 'A ajoute du texte', alice)
    expect(() => a.setStatus(edit.id, 'resolved', alice)).toThrow('statut')
  })

  it('les fils d\'une note ne melangent pas ceux d\'une autre', async () => {
    const { a } = await setup()
    a.comment('d1', 'Sur d1', alice)
    a.comment('d2', 'Sur d2', alice)
    expect(a.threads('d1').map(t => t.root.text)).toEqual(['Sur d1'])
  })
})
