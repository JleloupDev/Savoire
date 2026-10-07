// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Agents locaux rattaches a une personne : droits = mode ∩ droits de la
// personne, et attribution « agent, pour Jean » sur tout ce qu'ils font.
// Teste sur de vrais pairs du connecteur local, sans serveur.
import { describe, it, expect, afterEach } from 'vitest'
import { DocumentStore, VaultClient, type IVaultStorage } from '@savoire/platform'
import {
  AGENT_MODES, AgentContext, AgentPermissionError, ReviewService, describeActor, reviewText,
  reviewerAgent, runAgent, type IVaultSyncSession,
} from '@savoire/application'
import { InProcessPeerBus, LocalPeerVaultSessionFactory, type YjsCrdtAdapter } from '@savoire/infrastructure-sync'

const SETTLE_MS = 5
const settle = () => new Promise(r => setTimeout(r, SETTLE_MS * 4))
const mode = (id: string) => AGENT_MODES.find(m => m.id === id)!

const NOTE = 'Projet. TODO finir le plan. Voir [[existe]] et [[absente|alias]].'

const noStorage = {} as IVaultStorage
const noStore = new DocumentStore({ getDocumentContent: async () => '', writeDocumentContent: async () => {} })

describe('agents', () => {
  const sessions: IVaultSyncSession[] = []
  afterEach(async () => { for (const s of sessions.splice(0)) await s.dispose() })

  async function setup() {
    const factory = new LocalPeerVaultSessionFactory(new InProcessPeerBus(), { settleMs: SETTLE_MS })
    const peer = async (userId: string) => {
      const session = await factory.open({ vaultId: 'v1', token: '', userId, onChanged: () => {} })
      sessions.push(session)
      const client = new VaultClient('v1', '', noStorage, noStore, session.directory, () => undefined, session)
      return { session, client, review: new ReviewService(session) }
    }
    const alice = await peer('alice')
    const bob = await peer('bob')
    await alice.client.createFile('note.md')
    await alice.client.createFile('existe.md')
    const docId = alice.client.resolveDocumentId('note.md')!
    const raw = (alice.session.openDocument(docId) as YjsCrdtAdapter).rawDoc as { getText(n: string): { insert(i: number, t: string): void; toString(): string } }
    raw.getText('codemirror').insert(0, NOTE)
    await settle()
    const run = (modeId: string, canWrite = true) => runAgent({
      agent: reviewerAgent,
      mode: mode(modeId),
      user: { userId: 'alice', displayName: 'Alice', canWrite },
      target: { docId, path: 'note.md' },
      client: alice.client,
      session: alice.session,
      review: alice.review,
    })
    const text = () => raw.getText('codemirror').toString()
    return { alice, bob, docId, run, text }
  }

  it('le relecteur trouve les mots, les TODO et les liens sans note', () => {
    const f = reviewText(NOTE, t => t === 'existe')
    expect(f).toEqual({ words: 10, todos: 1, brokenLinks: ['absente'] })
  })

  it('un commentaire d\'une personne arrive chez les autres membres', async () => {
    const { alice, bob, docId } = await setup()
    alice.review.comment(docId, 'À relire', { kind: 'user', userId: 'alice', displayName: 'Alice' })
    await settle()
    expect(bob.review.list(docId).map(e => [e.text, describeActor(e.author)])).toEqual([['À relire', 'Alice']])
  })

  it('lecture : l\'agent lit et analyse, mais ne commente ni n\'ecrit', async () => {
    const { alice, docId, run, text } = await setup()
    const result = await run('read')
    expect(result.ok).toBe(true)
    expect(result.log[0]).toContain('[[absente]]')
    expect(alice.review.list(docId)).toEqual([])
    expect(text()).toBe(NOTE)
  })

  it('relecture : l\'agent commente en son nom d\'agent, pour la personne', async () => {
    const { bob, docId, run, text } = await setup()
    await run('review')
    await settle()
    const [entry] = bob.review.list(docId)
    expect(entry.kind).toBe('comment')
    expect(entry.text).toContain('1 TODO')
    expect(entry.author).toEqual({
      kind: 'agent', agentId: 'agent-reviewer', agentName: 'Relecteur',
      onBehalfOf: { userId: 'alice', displayName: 'Alice' },
    })
    expect(describeActor(entry.author)).toBe('Relecteur (IA), pour Alice')
    expect(text()).toBe(NOTE)
  })

  it('redaction : l\'agent ecrit dans la note, et l\'ecriture est tracee', async () => {
    const { bob, docId, run, text } = await setup()
    await run('write')
    await settle()
    expect(text()).toContain('> Relecture :')
    expect(await bob.session.readDocument(docId, 'crdt')).toContain('> Relecture :')
    expect(bob.review.list(docId).map(e => e.kind)).toEqual(['comment', 'edit'])
  })

  it('les droits de la personne bornent l\'agent : un lecteur ne le fait jamais ecrire', async () => {
    const { alice, docId, run, text } = await setup()
    const result = await run('write', false)
    expect(result.capabilities).not.toContain('documents.write')
    expect(result.capabilities).not.toContain('review.write')
    expect(alice.review.list(docId)).toEqual([])
    expect(text()).toBe(NOTE)
  })

  it('un appel hors droits est refuse, meme si l\'agent essaie', async () => {
    const { alice, docId } = await setup()
    const ctx = new AgentContext({
      actor: { kind: 'agent', agentId: 'x', agentName: 'X', onBehalfOf: { userId: 'alice', displayName: 'Alice' } },
      capabilities: new Set(mode('review').capabilities),
      client: alice.client, session: alice.session, review: alice.review,
    })
    expect(() => ctx.documents.append(docId, 'pirate')).toThrow(AgentPermissionError)
  })
})
