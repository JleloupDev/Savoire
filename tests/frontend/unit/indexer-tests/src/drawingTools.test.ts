// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Outils d'Excalidraw sur le pair (ADR-033) : ChatGPT et Claude, par le MCP
// du serveur, lisent et modifient les dessins. L'arbre du dessin est rejoue
// depuis son journal ; ce que l'outil y ecrit part a la fin de l'appel, en
// une difference, avec le ticket.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
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

const actor = { agentId: 'ag', agentName: 'Dessinateur', onBehalfOf: { userId: 'u1', displayName: 'Jean' } }
const agent = { id: 'ag', name: 'Dessinateur', description: '', instructions: '', ownerId: 'u1', permissions: { read: 'direct', edit: 'direct', create: 'direct' } }

async function ready(): Promise<Peer> {
  peer = await startPeer(backend, tmp.dir)
  await until(async () => (await peer!.status('v1')).body.status === 'ready', 10_000, 'construction')
  return peer
}

type ToolReply = { text: string; isError: boolean }

async function call(p: Peer, name: string, args: Record<string, unknown>, opts: { mode?: string; access?: unknown } = {}): Promise<ToolReply> {
  const r = await p.call<ToolReply>('v1', 'tools', 'call', { name, args, mode: opts.mode ?? 'direct', ticket: 't1', actor, agent }, opts.access)
  expect(r.status).toBe(200)
  return r.body.result
}

const box = { id: 'boite', type: 'rectangle', x: 0, y: 0, width: 120, height: 60, strokeColor: '#1e1e1e', backgroundColor: 'transparent', boundElements: null }
const ids = (text: string) => Object.fromEntries([...text.matchAll(/(\w+) → (\w+)/g)].map(m => [m[1], m[2]]))

describe('outils des dessins sur le pair', () => {
  it('le catalogue propose les outils des dessins', async () => {
    backend.writeNote('v1', 'a', 'A.md', 'x')
    const p = await ready()
    const r = await p.call<{ tools: { name: string }[] }>('v1', 'tools', 'list')
    expect(r.body.result.tools.map(t => t.name)).toEqual(expect.arrayContaining([
      'drawing_list', 'drawing_read', 'drawing_add', 'drawing_update', 'drawing_delete', 'drawing_diagram', 'drawing_create',
    ]))
  })

  it('lit un dessin, y pose un schema relie a l existant ; la difference part avec le ticket', async () => {
    backend.writeDrawing('v1', 'd', 'Schémas/Plan.excalidraw', [box])
    const p = await ready()
    expect((await call(p, 'drawing_list', {})).text).toBe('1 dessin(s) :\n- Schémas/Plan.excalidraw')
    expect((await call(p, 'drawing_read', { path: 'schémas/plan' })).text).toContain('- rectangle boite à (0, 0), 120×60')

    const r = await call(p, 'drawing_diagram', {
      path: 'Schémas/Plan', nodes: [{ key: 'a', text: 'Étape 1' }, { key: 'b', text: 'Étape 2' }],
      edges: [{ from: 'boite', to: 'a' }, { from: 'a', to: 'b', text: 'puis' }],
    })
    expect(r).toMatchObject({ isError: false })
    expect(r.text).toContain('Schéma dessiné (2 nœud(s), 2 flèche(s)) dans Schémas/Plan.excalidraw.')
    const k = ids(r.text)
    const els = backend.drawing('v1', 'd')
    expect(els.filter(e => e.type === 'arrow')).toHaveLength(2)
    expect(els.find(e => e.id === 'boite')).toMatchObject({ boundElements: [{ type: 'arrow', id: expect.any(String) }], version: 2 })
    expect(els.find(e => e.type === 'arrow' && (e.endBinding as { elementId: string }).elementId === k.b)).toMatchObject({ startBinding: { elementId: k.a } })
    // Une seule ecriture du document, puis la trace signee de l'agent.
    expect(backend.writes.map(w => [w.body.ticket, w.body.ops?.map(o => `${o.target}:${o.docId ?? o.ns}`)])).toEqual([
      ['t1', ['document:d']], ['t1', ['index:map/review']],
    ])
    expect(backend.reviewEntries('v1')).toMatchObject([{ kind: 'edit', docId: 'd', text: 'Dessiner un schéma', author: { kind: 'agent', agentName: 'Dessinateur' } }])

    // L'appel suivant relit le journal a jour : deplacer la boite, la fleche suit.
    const moved = await call(p, 'drawing_update', { path: 'Schémas/Plan', changes: [{ id: 'boite', dy: 300 }] })
    expect(moved.isError).toBe(false)
    expect(backend.drawing('v1', 'd').find(e => e.id === 'boite')).toMatchObject({ y: 300 })
  })

  it('cree un dessin avec des formes : inscription, dossier, puis le contenu', async () => {
    backend.writeNote('v1', 'a', 'A.md', 'x')
    const p = await ready()
    const r = await call(p, 'drawing_create', { path: 'Idées/Carte', shapes: [{ type: 'ellipse', x: 0, y: 0, text: 'Centre' }] })
    expect(r).toMatchObject({ isError: false, text: 'Dessin créé : 1 forme(s) dans Idées/Carte.excalidraw.' })
    const id = backend.writes.find(w => w.body.register?.length)!.body.register![0]!
    expect(backend.pathOf('v1', id)).toBe('Idées/Carte.excalidraw')
    expect(backend.drawing('v1', id).map(e => e.type).sort()).toEqual(['ellipse', 'text'])
  })

  it('un dessin tout juste cree se dessine aussitot, avant que l index le connaisse', async () => {
    backend.writeNote('v1', 'a', 'A.md', 'x')
    const p = await ready()
    // L'IA enchaine drawing_create et drawing_diagram : l'index a une ou deux secondes de retard.
    backend.feedPaused = true
    expect(await call(p, 'drawing_create', { path: 'Schémas/Processus' })).toMatchObject({ isError: false, text: 'Dessin créé : Schémas/Processus.excalidraw.' })
    const id = backend.writes.find(w => w.body.register?.length)!.body.register![0]!
    const r = await call(p, 'drawing_diagram', { path: 'Schémas/Processus', nodes: [{ key: 'a', text: 'Idée' }, { key: 'b', text: 'Prototype' }], edges: [{ from: 'a', to: 'b' }] })
    expect(r).toMatchObject({ isError: false })
    expect(r.text).toContain('Schéma dessiné (2 nœud(s), 1 flèche(s)) dans Schémas/Processus.excalidraw.')
    expect(backend.drawing('v1', id).filter(e => e.type === 'arrow')).toHaveLength(1)
    expect((await call(p, 'drawing_read', { path: 'Schémas/Processus' })).text).toContain('Idée')
  })

  it('mode proposition : une proposition « excalidraw.scene », le dessin ne change pas', async () => {
    backend.writeDrawing('v1', 'd', 'Plan.excalidraw', [box])
    const p = await ready()
    const r = await call(p, 'drawing_delete', { path: 'Plan', ids: ['boite'] }, { mode: 'propose' })
    expect(r).toMatchObject({ isError: false, text: 'Suppression de 1 élément(s) proposée dans Plan.excalidraw (Révision).' })
    expect(backend.drawing('v1', 'd')).toHaveLength(1)
    expect(backend.reviewEntries('v1')).toMatchObject([{
      kind: 'proposal', docId: 'd', proposalType: 'excalidraw.scene', status: 'open',
      payload: { elements: [{ id: 'boite', isDeleted: true }], base: { boite: { version: 1, versionNonce: 1 } } },
    }])
    expect(backend.writes.flatMap(w => w.body.ops ?? []).every(o => o.target === 'index')).toBe(true)
  })

  it('ACL : un dessin interdit a la personne n existe pas pour l agent', async () => {
    backend.writeDrawing('v1', 'p', 'Public/A.excalidraw', [box])
    backend.writeDrawing('v1', 's', 'Secret/S.excalidraw', [box])
    const p = await ready()
    const access = { base: 'write', rules: [{ folder: 'Secret', permission: 'none' }], closed: [] }
    expect((await call(p, 'drawing_list', {}, { access })).text).toBe('1 dessin(s) :\n- Public/A.excalidraw')
    expect((await call(p, 'drawing_read', { path: 'Secret/S' }, { access })).isError).toBe(true)
    expect((await call(p, 'drawing_add', { path: 'Secret/S', shapes: [{ type: 'text', x: 0, y: 0, text: 'x' }] }, { access })).isError).toBe(true)
    expect(backend.writes).toEqual([])
  })

  it('un outil en echec n ecrit rien', async () => {
    backend.writeDrawing('v1', 'd', 'Plan.excalidraw', [box])
    const p = await ready()
    const r = await call(p, 'drawing_add', { path: 'Plan', shapes: [{ type: 'arrow', from: 'boite', to: 'inconnu' }] })
    expect(r.isError).toBe(true)
    expect(r.text).toContain('Élément introuvable : inconnu')
    expect(backend.writes).toEqual([])
  })
})
