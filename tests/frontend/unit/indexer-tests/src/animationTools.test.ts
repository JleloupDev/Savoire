// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Outils des animations sur le pair (ADR-033) : ChatGPT et Claude, par le MCP
// du serveur, creent une animation (.anim), la modifient et l'integrent dans
// une diapositive d'une presentation.
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

const actor = { agentId: 'ag', agentName: 'Animateur', onBehalfOf: { userId: 'u1', displayName: 'Jean' } }
const agent = { id: 'ag', name: 'Animateur', description: '', instructions: '', ownerId: 'u1', permissions: { read: 'direct', edit: 'direct', create: 'direct' } }

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

describe('outils des animations sur le pair', () => {
  it('le catalogue propose les outils des animations', async () => {
    backend.writeNote('v1', 'a', 'A.md', 'x')
    const p = await ready()
    const r = await p.call<{ tools: { name: string }[] }>('v1', 'tools', 'list')
    expect(r.body.result.tools.map(t => t.name)).toEqual(expect.arrayContaining([
      'animation_list', 'animation_read', 'animation_create', 'animation_update', 'animation_embed',
    ]))
  })

  it('cree une animation, la modifie, puis l integre dans une diapositive', async () => {
    backend.writeNote('v1', 'c', 'Cours.md', '---\ntype: slides\n---\n# Cours\n\n---\n\n## Partie 1\n\nTexte\n')
    const p = await ready()
    const created = await call(p, 'animation_create', { path: 'Anims/Balle', html: '<div class="b"></div>', css: '.b { width: 20px }', script: 'timeline.add(".b", { x: 100 })' })
    expect(created).toMatchObject({ isError: false })
    expect(created.text).toContain('Anims/Balle.anim')
    const id = backend.writes.find(w => w.body.register?.length)!.body.register![0]!
    expect(backend.pathOf('v1', id)).toBe('Anims/Balle.anim')
    expect(backend.text('v1', id)).toContain('timeline.add(".b", { x: 100 })')

    // L'index du pair apprend la creation un peu apres (comme un appel suivant de l'IA).
    await until(async () => (await call(p, 'animation_list', {})).text.includes('Balle'), 10_000, 'animation indexee')
    const updated = await call(p, 'animation_update', { path: 'Anims/Balle', find: 'x: 100', replace: 'x: 300' })
    expect(updated).toMatchObject({ isError: false })
    expect(backend.text('v1', id)).toContain('x: 300')
    expect((await call(p, 'animation_list', {})).text).toBe('1 animation(s) :\n- Anims/Balle.anim')

    const embedded = await call(p, 'animation_embed', { note: 'Cours', animation: 'Balle', slide: 2, loop: true })
    expect(embedded).toMatchObject({ isError: false })
    expect(backend.text('v1', 'c')).toBe('---\ntype: slides\n---\n# Cours\n\n---\n\n## Partie 1\n\nTexte\n\n![[Balle.anim|boucle]]\n')
  })
})
