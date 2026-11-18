// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Pouvoir « tools » (ADR-033) : le pair execute les outils des agents pour les
// IA externes. Il lit les journaux, renvoie ses ecritures au serveur avec le
// ticket, et applique les regles d'acces (ACL) de la personne.
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

async function ready(): Promise<Peer> {
  peer = await startPeer(backend, tmp.dir)
  await until(async () => (await peer!.status('v1')).body.status === 'ready', 10_000, 'construction')
  return peer
}

type ToolReply = { text: string; isError: boolean; sources?: { path: string }[] }

function call(p: Peer, name: string, args: Record<string, unknown>, opts: { mode?: string; perms?: Record<string, string>; ticket?: string; access?: unknown } = {}) {
  return p.call<ToolReply>('v1', 'tools', 'call', {
    name, args, mode: opts.mode ?? 'direct', ticket: opts.ticket ?? 't1', actor,
    agent: agent(opts.perms ?? { read: 'direct', comment: 'direct', edit: 'direct', create: 'direct', organize: 'direct' }),
  }, opts.access)
}

describe('tools', () => {
  it('rend le catalogue du socle', async () => {
    backend.writeNote('v1', 'a', 'A.md', 'x')
    const p = await ready()
    const r = await p.call<{ tools: { name: string; action: string }[] }>('v1', 'tools', 'list')
    expect(r.status).toBe(200)
    expect(r.body.result.tools.map(t => t.name)).toEqual(expect.arrayContaining(['search', 'read_note', 'edit_note', 'append', 'create_note', 'move_note', 'comment']))
  })

  it('lit, puis ecrit dans la note : la modification part au serveur avec le ticket', async () => {
    backend.writeNote('v1', 'a', 'Projets/Plan.md', 'Bonjour le monde')
    const p = await ready()
    const read = await call(p, 'read_note', { path: 'projets/plan.md' })
    expect(read.body.result.text).toContain('Bonjour le monde')
    const r = await call(p, 'edit_note', { id: 'a', find: 'le monde', replace: 'tout le monde' })
    expect(r.body.result.isError).toBe(false)
    expect(backend.text('v1', 'a')).toBe('Bonjour tout le monde')
    expect(backend.writes.map(w => [w.body.ticket, w.body.ops?.map(o => o.target)])).toEqual([['t1', ['document']], ['t1', ['index']]])
    // La trace de l'ecriture, signee de l'agent.
    expect(backend.reviewEntries('v1')).toMatchObject([{ kind: 'edit', docId: 'a', author: { kind: 'agent', agentName: 'Secrétaire' } }])
  })

  it('mode proposition : une suggestion ancree, la note ne change pas', async () => {
    backend.writeNote('v1', 'a', 'A.md', 'Il ont manger')
    const p = await ready()
    const r = await call(p, 'edit_note', { id: 'a', find: 'Il ont manger', replace: 'Ils ont mangé' }, { mode: 'propose', perms: { read: 'direct', edit: 'direct' } })
    expect(r.body.result.isError).toBe(false)
    expect(backend.text('v1', 'a')).toBe('Il ont manger')
    const [entry] = backend.reviewEntries('v1')
    expect(entry).toMatchObject({ kind: 'suggestion', replacement: 'Ils ont mangé', anchor: { quote: 'Il ont manger' } })
    // L'ancre se relit dans le document du client, comme ReviewService.locate, meme apres une frappe avant.
    const doc = backend.vaults.get('v1')!.docs.get('a')!.doc
    doc.getText('codemirror').insert(0, 'Hier, ')
    const anchor = (entry as { anchor: { from: object; to: object } }).anchor
    const at = (rp: object) => Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(rp), doc)!.index
    expect(doc.getText('codemirror').toString().slice(at(anchor.from), at(anchor.to))).toBe('Il ont manger')
  })

  it('le serveur refuse : l outil le dit, rien ne change', async () => {
    backend.writeNote('v1', 'a', 'A.md', 'x')
    backend.tickets.set('t-propose', 'propose')
    const p = await ready()
    const r = await call(p, 'append', { id: 'a', text: 'y' }, { ticket: 't-propose' })
    expect(r.body.result.isError).toBe(true)
    expect(backend.text('v1', 'a')).toBe('x')
  })

  it('cree une note et la deplace, dossiers et placement annonces au serveur', async () => {
    backend.writeNote('v1', 'a', 'A.md', 'x')
    const p = await ready()
    const created = await call(p, 'create_note', { path: 'Réunions/2026-11-18', content: '# Compte rendu' })
    expect(created.body.result.text).toContain('Réunions/2026-11-18.md')
    const w = backend.writes.at(-1)!
    const id = w.body.register![0]!
    expect(w.body.folders).toEqual([{ docId: id, folder: 'Réunions' }])
    expect(backend.pathOf('v1', id)).toBe('Réunions/2026-11-18.md')
    expect(backend.text('v1', id)).toBe('# Compte rendu')
    await call(p, 'move_note', { id: 'a', to: 'Archives/' })
    expect(backend.pathOf('v1', 'a')).toBe('Archives/A.md')
  })

  it('deplacer une note fait suivre les liens des notes qui la citent (meme canal que l appli)', async () => {
    backend.writeNote('v1', 'a', 'Inbox/Idee.md', 'une idee')
    backend.writeNote('v1', 'c', 'Journal.md', 'Voir [[Idee]] et [[Autre]].')
    const p = await ready()
    const r = await call(p, 'move_note', { id: 'a', to: 'Archives/Projet.md' })
    expect(r.body.result.isError).toBe(false)
    expect(backend.pathOf('v1', 'a')).toBe('Archives/Projet.md')
    expect(backend.text('v1', 'c')).toBe('Voir [[Projet]] et [[Autre]].')
  })

  it('ACL : une note interdite a la personne n existe pas pour l agent', async () => {
    backend.writeNote('v1', 'a', 'Public/A.md', 'plan commun')
    backend.writeNote('v1', 's', 'Secret/S.md', 'plan secret')
    const p = await ready()
    const access = { base: 'write', rules: [{ folder: 'Secret', permission: 'none' }], closed: [] }
    const found = await call(p, 'search', { query: 'plan' }, { access })
    expect(found.body.result.sources?.map(s => s.path)).toEqual(['Public/A.md'])
    expect((await call(p, 'read_note', { path: 'Secret/S.md' }, { access })).body.result.isError).toBe(true)
    // Les autres pouvoirs aussi, par la meme regle.
    const search = await p.call<{ hits: { id: string }[] }>('v1', 'search', 'run', { text: 'plan' }, access)
    expect(search.body.result.hits.map(h => h.id)).toEqual(['a'])
    expect((await p.call('v1', 'documents', 'read', { id: 's' }, access)).status).toBe(404)
    expect((await p.call('v1', 'documents', 'read', { id: 's' }, { base: 'admin' })).status).toBe(200)
  })
})
