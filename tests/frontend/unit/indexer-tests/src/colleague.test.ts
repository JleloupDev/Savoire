// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Le pair et l'IA « collegue » : il n'ecrit pas dans le paragraphe ou la
// personne tape (le serveur joint `typing` a tools.call), ses commentaires
// sont peu nombreux et courts, et il sert les demandes adressees a l'agent
// (list_requests ; reply les clot, une seule fois).
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as Y from 'yjs'
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
const agent = (permissions: Record<string, string>) => ({ id: 'ag', name: 'Secrétaire', description: '', instructions: '', ownerId: 'u1', permissions })
const ALL = { read: 'direct', comment: 'direct', edit: 'direct', create: 'direct', organize: 'direct' }

async function ready(): Promise<Peer> {
  peer = await startPeer(backend, tmp.dir)
  await until(async () => (await peer!.status('v1')).body.status === 'ready', 10_000, 'construction')
  return peer
}

type ToolReply = { text: string; isError: boolean }

function call(p: Peer, name: string, args: Record<string, unknown>, opts: { mode?: string; typing?: unknown; access?: unknown; who?: typeof actor } = {}) {
  const who = opts.who ?? actor
  return p.call<ToolReply>('v1', 'tools', 'call', {
    name, args, mode: opts.mode ?? 'direct', ticket: 't1', actor: who, agent: { ...agent(ALL), id: who.agentId, name: who.agentName },
    ...(opts.typing ? { typing: opts.typing } : {}),
  }, opts.access)
}

const NOTE = 'Premier paragraphe.\n\nCelui qu’elle écrit.\n\nUn troisième.'

/** Ce que le serveur joint : le curseur de la personne (position relative Yjs, base64), il y a `ageMs`. */
function typingAt(docId: string, pos: number, ageMs = 1200) {
  const doc = backend.vaults.get('v1')!.docs.get(docId)!.doc
  const rel = Buffer.from(Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(doc.getText('codemirror'), pos, 0))).toString('base64')
  const text = doc.getText('codemirror').toString()
  return { docId, ageMs, blockHash: '', anchor: { docId, start: rel, end: rel, quote: '', prefix: text.slice(Math.max(0, pos - 32), pos), suffix: text.slice(pos, pos + 32) } }
}

describe('le pair n ecrit pas la ou la personne tape', () => {
  it('refuse l ecriture dans son paragraphe, ecrit dans un autre, et propose si on le lui demande', async () => {
    backend.writeNote('v1', 'a', 'Plan.md', NOTE)
    const p = await ready()
    const typing = typingAt('a', NOTE.indexOf('écrit.') + 'écrit.'.length)

    const refused = await call(p, 'edit_note', { id: 'a', find: 'Celui qu’elle écrit.', replace: 'Réécrit par l’IA.' }, { typing })
    expect(refused.body.result.isError).toBe(true)
    expect(refused.body.result.text).toContain('La personne écrit dans ce paragraphe en ce moment')
    expect(backend.text('v1', 'a')).toBe(NOTE)
    expect(backend.writes).toEqual([])

    // Un autre paragraphe : ecrit.
    const elsewhere = await call(p, 'edit_note', { id: 'a', find: 'Un troisième.', replace: 'Un troisième, retouché.' }, { typing })
    expect(elsewhere.body.result.isError).toBe(false)
    expect(backend.text('v1', 'a')).toContain('Un troisième, retouché.')

    // Dans son paragraphe : une proposition, sans toucher la note.
    const before = backend.text('v1', 'a')
    const proposed = await call(p, 'edit_note', { id: 'a', find: 'Celui qu’elle écrit.', replace: 'Réécrit par l’IA.', propose: true }, { typing })
    expect(proposed.body.result.isError).toBe(false)
    expect(backend.text('v1', 'a')).toBe(before)
    expect(backend.reviewEntries('v1').filter(e => e.kind === 'suggestion')).toMatchObject([{ replacement: 'Réécrit par l’IA.', anchor: { quote: 'Celui qu’elle écrit.' } }])
  })

  it('le curseur suit le texte : la frappe d apres ne trompe pas le pair', async () => {
    backend.writeNote('v1', 'a', 'Plan.md', NOTE)
    const p = await ready()
    const typing = typingAt('a', NOTE.indexOf('écrit.') + 'écrit.'.length)
    // Elle a continue de taper depuis : le texte autour du curseur n'est plus celui de l'entree.
    const doc = backend.vaults.get('v1')!.docs.get('a')!.doc
    doc.getText('codemirror').insert(NOTE.indexOf('écrit.') + 'écrit.'.length, ' Et elle continue')
    backend.type('v1', 'a', '')
    await until(async () => (await call(p, 'read_note', { id: 'a' })).body.result.text.includes('Et elle continue'), 10_000, 'frappe vue')
    const edit = await call(p, 'edit_note', { id: 'a', find: 'Et elle continue', replace: 'Et elle poursuit' }, { typing })
    expect(edit.body.result.isError).toBe(true)
    expect(edit.body.result.text).toContain('La personne écrit dans ce paragraphe')
    expect(backend.writes).toEqual([])
  })

  it('apres 8 s sans frappe, ou sans rien du serveur, il ecrit', async () => {
    backend.writeNote('v1', 'a', 'Plan.md', NOTE)
    const p = await ready()
    const old = await call(p, 'edit_note', { id: 'a', find: 'Celui qu’elle écrit.', replace: 'Retouché.' }, { typing: typingAt('a', 30, 8000) })
    expect(old.body.result.isError).toBe(false)
    const none = await call(p, 'append', { id: 'a', text: 'Fin.' })
    expect(none.body.result.isError).toBe(false)
    // Une frappe dans une autre note ne gene pas.
    backend.writeNote('v1', 'b', 'Autre.md', 'Autre note.')
    await until(async () => !(await call(p, 'read_note', { id: 'b' })).body.result.isError, 10_000, 'autre note')
    const other = await call(p, 'append', { id: 'a', text: 'Encore.' }, { typing: typingAt('b', 5) })
    expect(other.body.result.isError).toBe(false)
    expect(backend.text('v1', 'a')).toContain('Encore.')
  })
})

describe('commentaires du pair : peu et courts', () => {
  it('refuse un commentaire trop long, et le quatrieme d affilee sur une note', async () => {
    backend.writeNote('v1', 'a', 'Plan.md', NOTE)
    const p = await ready()
    const long = await call(p, 'comment', { id: 'a', text: 'mot '.repeat(120) })
    expect(long.body.result.isError).toBe(true)
    expect(long.body.result.text).toContain('400 au plus')
    for (let i = 0; i < 3; i++) expect((await call(p, 'comment', { id: 'a', text: `Remarque ${i + 1}.`, quote: 'Premier paragraphe.' })).body.result.isError).toBe(false)
    const fourth = await call(p, 'comment', { id: 'a', text: 'Encore une.' })
    expect(fourth.body.result.isError).toBe(true)
    expect(fourth.body.result.text).toContain('3 au plus à la suite')
    expect(backend.reviewEntries('v1').filter(e => e.kind === 'comment')).toHaveLength(3)
    // Un autre agent garde son propre compte.
    const other = await call(p, 'comment', { id: 'a', text: 'Un autre avis.' }, { who: { ...actor, agentId: 'ag2', agentName: 'Archiviste' } })
    expect(other.body.result.isError).toBe(false)
  })
})

/** Un commentaire de la personne, adresse a un agent (comme ReviewService.comment avec une demande). */
function ask(id: string, docId: string, text: string, quote: string, request: Record<string, unknown>, more: Record<string, unknown> = {}): void {
  backend.vault('v1').review.doc.getMap('entries').set(id, {
    id, docId, kind: 'comment', text, status: 'open', createdAt: '2026-11-25T10:00:00.000Z',
    author: { kind: 'user', userId: 'u1', displayName: 'Jean' }, ...(quote ? { anchor: { quote } } : {}),
    request: { agentName: 'Secrétaire', via: 'external', askedAt: '2026-11-25T10:00:00.000Z', ...request }, ...more,
  })
}

describe('demandes adressees a l agent', () => {
  it('list_requests ne rend que les demandes ouvertes de cet agent, dans les notes que la personne lit', async () => {
    backend.writeNote('v1', 'a', 'Public/Plan.md', NOTE)
    backend.writeNote('v1', 'b', 'Prive/Secret.md', 'secret')
    ask('q1', 'a', '@Secrétaire reformule plus court', 'Celui qu’elle écrit.', { agentId: 'ag', state: 'open' })
    ask('q2', 'a', 'pour un autre agent', '', { agentId: 'autre', state: 'open' })
    ask('q3', 'a', 'prise par l’appli', '', { agentId: 'ag', state: 'running', via: 'app' })
    ask('q4', 'a', 'déjà répondue', '', { agentId: 'ag', state: 'done' })
    ask('q5', 'b', 'dans une note interdite', '', { agentId: 'ag', state: 'open' })
    ask('q6', 'a', 'fil résolu', '', { agentId: 'ag', state: 'open' }, { status: 'resolved' })
    // Un autre membre du vault : son IA a lui la prendra, pas celle de Jean.
    ask('q7', 'a', 'demande de Marie', '', { agentId: 'ag', state: 'open' }, { author: { kind: 'user', userId: 'u2', displayName: 'Marie' } })
    const p = await ready()
    const tools = await p.call<{ tools: { name: string; action: string }[] }>('v1', 'tools', 'list')
    expect(tools.body.result.tools.find(t => t.name === 'list_requests')).toMatchObject({ action: 'read' })

    const access = { base: 'write', rules: [{ folder: 'Prive', permission: 'none' }], closed: [] }
    const r = await call(p, 'list_requests', {}, { access })
    expect(r.body.result.isError).toBe(false)
    const text = r.body.result.text
    expect(text).toContain('1 demande(s) pour vous')
    expect(text).toContain('[q1] Public/Plan.md')
    expect(text).toContain('de Jean : @Secrétaire reformule plus court')
    expect(text).toContain('« Celui qu’elle écrit. »')
    for (const hidden of ['q2', 'q3', 'q4', 'q5', 'q6', 'q7']) expect(text).not.toContain(`[${hidden}]`)
    // Repondre dans le fil de Marie ne clot pas sa demande.
    expect((await call(p, 'reply', { thread: 'q7', text: 'Vu.' }, { access })).body.result.text).toBe('Réponse ajoutée.')
    expect(backend.reviewEntries('v1').find(e => e.id === 'q7')).toMatchObject({ request: { state: 'open' } })
    // Sans regle d'acces (proprietaire) : la note privee compte aussi.
    expect((await call(p, 'list_requests', {})).body.result.text).toContain('2 demande(s) pour vous')
  })

  it('repondre a une demande la clot : elle n est plus listee, jamais traitee deux fois', async () => {
    backend.writeNote('v1', 'a', 'Plan.md', NOTE)
    ask('q1', 'a', '@Secrétaire reformule plus court', 'Celui qu’elle écrit.', { agentId: 'ag', state: 'open' })
    const p = await ready()
    expect((await call(p, 'list_requests', {})).body.result.text).toContain('[q1]')

    const reply = await call(p, 'reply', { thread: 'q1', text: 'Reformulé : « Elle l’écrit. »' })
    expect(reply.body.result.isError).toBe(false)
    expect(reply.body.result.text).toBe('Réponse ajoutée : la demande est close.')
    const entries = backend.reviewEntries('v1')
    const root = entries.find(e => e.id === 'q1') as { text: string; request: { state: string; doneAt?: string; agentId: string }; anchor: { quote: string } }
    // La racine garde tout ; seul l'etat de la demande change.
    expect(root).toMatchObject({ text: '@Secrétaire reformule plus court', anchor: { quote: 'Celui qu’elle écrit.' }, request: { agentId: 'ag', state: 'done' } })
    expect(root.request.doneAt).toBeTruthy()
    expect(entries.find(e => e.parentId === 'q1')).toMatchObject({ kind: 'comment', text: 'Reformulé : « Elle l’écrit. »', author: { kind: 'agent', agentId: 'ag' } })

    expect((await call(p, 'list_requests', {})).body.result.text).toBe('Aucune demande en attente pour vous.')
    // Une seconde reponse est une simple reponse.
    expect((await call(p, 'reply', { thread: 'q1', text: 'Un détail.' })).body.result.text).toBe('Réponse ajoutée.')
  })

  it('un autre agent qui repond ne clot pas la demande ; une relance porte le texte de la reponse', async () => {
    backend.writeNote('v1', 'a', 'Plan.md', NOTE)
    ask('q1', 'a', 'reformule', 'Premier paragraphe.', { agentId: 'ag', state: 'open', entryId: 'q1-r' })
    backend.vault('v1').review.doc.getMap('entries').set('q1-r', {
      id: 'q1-r', docId: 'a', kind: 'comment', text: '@Secrétaire plus formel, s’il te plaît', parentId: 'q1', createdAt: '2026-11-25T10:05:00.000Z',
      author: { kind: 'user', userId: 'u1', displayName: 'Jean' },
    })
    const p = await ready()
    const other = await call(p, 'reply', { thread: 'q1', text: 'Je passe.' }, { who: { ...actor, agentId: 'ag2', agentName: 'Archiviste' } })
    expect(other.body.result.text).toBe('Réponse ajoutée.')
    const list = await call(p, 'list_requests', {})
    expect(list.body.result.text).toContain('[q1] Plan.md')
    expect(list.body.result.text).toContain('@Secrétaire plus formel, s’il te plaît')
  })
})
