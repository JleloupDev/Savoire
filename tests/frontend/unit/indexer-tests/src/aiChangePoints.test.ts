// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Les ecritures de ChatGPT et Claude par le pair (ADR-033) laissent un point
// d'historique dans la note, annulable seul (infrastructure-sync/AiChanges.ts).
// Le point part DANS la derniere mise a jour du texte : pas une ecriture de
// plus. Qui a rejoue la note peut annuler le point.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { planTyping } from '../../../../../packages/agent-core/src/typing'
import { AI_CHANGES_MAP, displayAiChanges, undoAiChanges } from '../../../../../packages/infrastructure-sync/src/AiChanges'
import { TYPING } from '../../../../../apps/indexer/src/agentTools'
import { FakeBackend } from './fakeBackend'
import { Peer, TOKEN, startPeer, tempDir, until } from './harness'

let backend: FakeBackend
let peer: Peer | undefined
let tmp: { dir: string; cleanup: () => void }

beforeEach(async () => {
  backend = await new FakeBackend({ token: TOKEN }).start()
  tmp = tempDir()
})

afterEach(async () => {
  await peer?.stop()
  peer = undefined
  await backend.stop()
  tmp.cleanup()
})

const actor = { agentId: 'ag', agentName: 'Secrétaire', onBehalfOf: { userId: 'u1', displayName: 'Jean' } }
const agent = { id: 'ag', name: 'Secrétaire', color: '#0A7FC2', description: '', instructions: '', ownerId: 'u1', permissions: { read: 'direct', edit: 'direct' } }
const JEAN = { id: 'u1', name: 'Jean' }

async function ready(): Promise<Peer> {
  peer = await startPeer(backend, tmp.dir)
  await until(async () => (await peer!.status('v1')).body.status === 'ready', 10_000, 'construction')
  return peer
}

type ToolReply = { text: string; isError: boolean }

async function call(p: Peer, name: string, args: Record<string, unknown>): Promise<ToolReply> {
  const r = await p.call<ToolReply>('v1', 'tools', 'call', { name, args, mode: 'direct', ticket: 't1', actor, agent })
  expect(r.status).toBe(200)
  return r.body.result
}

const NOTE = '# Plan\n\nIntroduction. ^intro\n\n## MCP\n\nLe serveur parle aux IA.\n\n## Suite\n\nLa suite.'
const LONG = 'Voici un long paragraphe écrit par une IA, que les personnes qui ont la note ouverte doivent voir arriver petit à petit, mot après mot, sans attendre la fin.'
const AFTER_LONG = NOTE.replace('Introduction. ^intro', `Introduction. ^intro\n\n${LONG}`)

const docWrites = () => backend.writes.filter(w => w.status === 200 && w.body.ops?.some(o => o.target === 'document'))
const ydoc = (id: string) => backend.vaults.get('v1')!.docs.get(id)!.doc
// Les types de Yjs passent ici ; AiChanges decrit lui-meme ce qu'il attend : un cast.
const points = (doc: Y.Doc) => displayAiChanges(doc as never)
const undo = (doc: Y.Doc, parts: readonly string[]) => undoAiChanges(doc as never, doc.getText('codemirror') as never, parts, JEAN)

/**
 * Rejoue les ecritures de la note une par une sur son etat d'avant : apres
 * chacune, le texte et le nombre de points ranges.
 */
function replay(before: Uint8Array): { text: string; points: number }[] {
  const doc = new Y.Doc()
  Y.applyUpdate(doc, before)
  return docWrites().flatMap(w => w.body.ops!.filter(o => o.target === 'document').map(o => {
    Y.applyUpdate(doc, Buffer.from(o.update, 'base64'))
    return { text: doc.getText('codemirror').toString(), points: doc.getMap(AI_CHANGES_MAP).size }
  }))
}

describe('les ecritures du pair laissent un point d historique', () => {
  it('une retouche : une seule ecriture, qui porte le texte et le point ; annuler remet le texte', async () => {
    backend.writeNote('v1', 'a', 'Plan.md', NOTE)
    const p = await ready()
    const before = Y.encodeStateAsUpdate(ydoc('a'))
    const r = await call(p, 'edit_note', { id: 'a', find: 'aux IA', replace: 'à ChatGPT', why: 'préciser' })
    expect(r.isError).toBe(false)
    // Comme avant les points : la note, puis la trace dans la Revision. Rien de plus.
    expect(backend.writes.map(w => [w.status, w.body.ops?.map(o => o.target)])).toEqual([[200, ['document']], [200, ['index']]])
    expect(replay(before)).toEqual([{ text: NOTE.replace('aux IA', 'à ChatGPT'), points: 1 }])

    const [point] = points(ydoc('a'))
    expect(point).toMatchObject({
      agent: { id: 'ag', name: 'Secrétaire', color: '#0a7fc2' },
      forUser: JEAN,
      summaries: ['passage remplacé'], reasons: ['préciser'],
      count: 1, inserted: 'à ChatGPT'.length, deleted: 'aux IA'.length,
    })
    expect(undo(ydoc('a'), point!.parts)).toEqual({ ok: true, partial: false })
    expect(backend.text('v1', 'a')).toBe(NOTE)
    expect(points(ydoc('a'))[0]!.undone?.by).toEqual(JEAN)
  })

  it('effet de frappe : autant d ecritures que de morceaux, le point dans la derniere', async () => {
    backend.writeNote('v1', 'a', 'Plan.md', NOTE)
    const p = await ready()
    const before = Y.encodeStateAsUpdate(ydoc('a'))
    const r = await call(p, 'patch_note', { id: 'a', ops: [{ op: 'insert_after', ref: '^intro', text: LONG }], why: 'développer' })
    expect(r.isError).toBe(false)
    expect(backend.text('v1', 'a')).toBe(AFTER_LONG)
    const steps = replay(before)
    expect(steps.length).toBeGreaterThan(3)
    // Le nombre d'ecritures est celui du plan de frappe, comme avant les points : la premiere, puis une par morceau.
    const plan = planTyping([{ from: 0, to: 0, text: AFTER_LONG.slice(NOTE.indexOf('\n\n## MCP'), AFTER_LONG.indexOf('\n\n## MCP')) }], TYPING)
    expect(steps.length).toBe(1 + plan.tails.reduce((n, t) => n + t.chunks.length, 0))
    // Chaque ecriture allonge le texte : aucune n'est la pour le point seul.
    for (let i = 1; i < steps.length; i++) expect(steps[i]!.text.length).toBeGreaterThan(steps[i - 1]!.text.length)
    // Le point n'arrive qu'avec le dernier morceau.
    expect(steps.map(s => s.points)).toEqual([...steps.slice(1).map(() => 0), 1])
    expect(steps.at(-1)!.text).toBe(AFTER_LONG)
    // Une ecriture de note par morceau, puis la trace : la Revision n'en recoit qu'une.
    expect(backend.writes.filter(w => w.body.ops?.some(o => o.target === 'index'))).toHaveLength(1)
    expect(backend.writes).toHaveLength(steps.length + 1)

    // Un seul point pour tout le texte, qui s'annule d'un coup, meme si Jean a tape depuis.
    const all = points(ydoc('a'))
    expect(all).toHaveLength(1)
    expect(all[0]).toMatchObject({ summaries: ['1 retouche'], reasons: ['développer'], count: 1, deleted: 0 })
    expect(all[0]!.inserted).toBe(AFTER_LONG.length - NOTE.length)
    ydoc('a').getText('codemirror').insert(0, 'Jean : ')
    expect(undo(ydoc('a'), all[0]!.parts)).toEqual({ ok: true, partial: false })
    expect(backend.text('v1', 'a')).toBe(`Jean : ${NOTE}`)
  })

  it('une ecriture echoue en route : le reste part d un coup, avec le point', async () => {
    backend.writeNote('v1', 'a', 'Plan.md', NOTE)
    const p = await ready()
    const before = Y.encodeStateAsUpdate(ydoc('a'))
    // Le serveur refuse la troisieme ecriture de la note, une fois.
    const fake = backend as unknown as { applyWrite(vaultId: string, body: unknown): number }
    const real = fake.applyWrite.bind(backend)
    let n = 0
    fake.applyWrite = (vaultId, body) => (++n === 3 ? 503 : real(vaultId, body))
    const r = await call(p, 'patch_note', { id: 'a', ops: [{ op: 'insert_after', ref: '^intro', text: LONG }] })
    expect(r.isError).toBe(false)
    expect(backend.text('v1', 'a')).toBe(AFTER_LONG)
    // Deux morceaux, un refus, puis tout le reste en une ecriture, avec le point.
    expect(backend.writes.slice(0, 4).map(w => w.status)).toEqual([200, 200, 503, 200])
    const steps = replay(before)
    expect(steps.map(s => s.points)).toEqual([0, 0, 1])
    expect(steps.at(-1)!.text).toBe(AFTER_LONG)
    const all = points(ydoc('a'))
    expect(all).toHaveLength(1)
    expect(undo(ydoc('a'), all[0]!.parts).ok).toBe(true)
    expect(backend.text('v1', 'a')).toBe(NOTE)
  })
})
