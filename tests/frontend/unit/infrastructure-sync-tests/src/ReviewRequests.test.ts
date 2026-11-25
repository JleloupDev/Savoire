// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Demandes a un agent dans la Revision : un commentaire adresse a un agent
// porte une demande, avec son etat. Prise par l'appli, elle n'est pas
// « ouverte » ; une demande n'est jamais traitee deux fois.
import { describe, it, expect, afterEach } from 'vitest'
import { REQUEST_STALE_MS, ReviewService, type AgentActor, type IVaultSyncSession, type UserActor } from '@savoire/application'
import { InProcessPeerBus, LocalPeerVaultSessionFactory } from '@savoire/infrastructure-sync'

const SETTLE_MS = 5
const settle = () => new Promise(r => setTimeout(r, SETTLE_MS * 4))
const alice: UserActor = { kind: 'user', userId: 'alice', displayName: 'Alice' }
const relecteur: AgentActor = { kind: 'agent', agentId: 'a1', agentName: 'Relecteur', onBehalfOf: { userId: 'alice', displayName: 'Alice' } }
const inApp = { agentId: 'a1', agentName: 'Relecteur', via: 'app' as const }
const external = { agentId: 'a1', agentName: 'Relecteur', via: 'external' as const }

describe('ReviewService : demandes a un agent', () => {
  const sessions: IVaultSyncSession[] = []
  afterEach(async () => { for (const s of sessions.splice(0)) await s.dispose() })

  async function setup() {
    const factory = new LocalPeerVaultSessionFactory(new InProcessPeerBus(), { settleMs: SETTLE_MS })
    const clock = { t: Date.parse('2026-11-25T10:00:00Z') }
    const open = async (userId: string) => {
      const s = await factory.open({ vaultId: 'v1', token: '', userId, onChanged: () => {} })
      sessions.push(s)
      return new ReviewService(s, () => new Date(clock.t += 1000))
    }
    return { a: await open('alice'), b: await open('bob'), clock }
  }

  it('un commentaire sans agent reste un simple commentaire', async () => {
    const { a } = await setup()
    expect(a.comment('d1', 'À revoir', alice).request).toBeUndefined()
    expect(a.openRequests('a1')).toEqual([])
  })

  it('pour un agent de l appli, la demande est prise des qu elle est posee : jamais « ouverte »', async () => {
    const { a, b } = await setup()
    const root = a.comment('d1', '@Relecteur reformule', alice, undefined, undefined, inApp)
    expect(root.request).toMatchObject({ agentId: 'a1', agentName: 'Relecteur', via: 'app', state: 'running' })
    await settle()
    // Ni cette appli ni une autre ne la voient « a prendre » (IA externe comprise).
    expect(a.openRequests('a1')).toEqual([])
    expect(b.openRequests('a1')).toEqual([])
    // L'agent repond, la demande est close.
    const askedAt = root.request!.askedAt
    expect(a.isRunning(root.id, askedAt)).toBe(true)
    a.reply(root.id, 'Reformulé.', relecteur)
    expect(a.finishRequest(root.id, askedAt, 'done')?.request).toMatchObject({ state: 'done' })
    // Une seconde fin (execution en double) ne change rien.
    expect(a.finishRequest(root.id, askedAt, 'failed', 'trop tard')).toBeNull()
    expect(a.thread(root.id)!.root.request).toMatchObject({ state: 'done' })
    expect(a.thread(root.id)!.root.request!.error).toBeUndefined()
  })

  it('pour une IA externe, la demande attend ; y repondre la clot, une seule fois, et seulement par son agent', async () => {
    const { a, b } = await setup()
    const root = a.comment('d1', 'reformule', alice, undefined, undefined, external)
    expect(root.request).toMatchObject({ via: 'external', state: 'open' })
    await settle()
    expect(b.openRequests('a1').map(t => t.root.id)).toEqual([root.id])
    expect(b.openRequests('autre')).toEqual([])
    expect(b.closeRequest(root.id, 'autre')).toBe(false)
    expect(b.closeRequest(root.id, 'a1')).toBe(true)
    expect(b.closeRequest(root.id, 'a1')).toBe(false)
    await settle()
    expect(a.openRequests('a1')).toEqual([])
    expect(a.thread(root.id)!.root.request).toMatchObject({ state: 'done' })
    // Un fil resolu n'est plus une demande a prendre.
    const other = a.comment('d1', 'autre demande', alice, undefined, undefined, external)
    a.setStatus(other.id, 'resolved', alice)
    expect(a.openRequests('a1')).toEqual([])
  })

  it('un echec se dit, et la demande se relance ; la reponse d une execution depassee est jetee', async () => {
    const { a } = await setup()
    const root = a.comment('d1', '@Relecteur reformule', alice, undefined, undefined, inApp)
    const first = root.request!.askedAt
    expect(a.finishRequest(root.id, first, 'failed', 'Aucune IA configurée')?.request).toMatchObject({ state: 'failed', error: 'Aucune IA configurée' })
    const again = a.ask(root.id, inApp)
    expect(again.request).toMatchObject({ state: 'running' })
    expect(again.request!.error).toBeUndefined()
    expect(again.request!.askedAt).not.toBe(first)
    // L'ancienne execution finit apres coup : elle ne compte plus.
    expect(a.isRunning(root.id, first)).toBe(false)
    expect(a.finishRequest(root.id, first, 'done')).toBeNull()
    expect(a.finishRequest(root.id, again.request!.askedAt, 'done')?.request?.state).toBe('done')
  })

  it('on ne relance pas une demande en cours, sauf si elle est interrompue depuis longtemps', async () => {
    const { a, clock } = await setup()
    const root = a.comment('d1', '@Relecteur reformule', alice, undefined, undefined, inApp)
    expect(() => a.ask(root.id, inApp)).toThrow('un agent travaille déjà sur cette demande')
    expect(a.stale(a.thread(root.id)!.root.request!)).toBe(false)
    clock.t += REQUEST_STALE_MS + 1000
    expect(a.stale(a.thread(root.id)!.root.request!)).toBe(true)
    expect(a.ask(root.id, external).request).toMatchObject({ via: 'external', state: 'open' })
  })

  it('une reponse de la personne peut relancer le fil : la demande porte cette reponse, et rouvre le fil', async () => {
    const { a } = await setup()
    const root = a.comment('d1', 'reformule', alice, undefined, undefined, external)
    a.closeRequest(root.id, 'a1')
    a.setStatus(root.id, 'resolved', alice)
    const reply = a.reply(root.id, '@Relecteur plus formel', alice)
    const next = a.ask(root.id, external, reply.id)
    expect(next.request).toMatchObject({ state: 'open', entryId: reply.id })
    expect(next.status).toBe('open')
    expect(a.openRequests('a1').map(t => t.root.id)).toEqual([root.id])
    // Une demande ne se pose que sur un commentaire.
    const edit = a.recordEdit('d1', 'trace', relecteur)
    expect(() => a.ask(edit.id, external)).toThrow('une demande se pose sur un commentaire')
  })
})
