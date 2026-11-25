// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Outils des presentations sur le pair (ADR-033) : ChatGPT et Claude, par le
// MCP du serveur, lisent le plan d'une presentation et reglent son allure.
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

const actor = { agentId: 'ag', agentName: 'Mise en page', onBehalfOf: { userId: 'u1', displayName: 'Jean' } }
const agent = { id: 'ag', name: 'Mise en page', description: '', instructions: '', ownerId: 'u1', permissions: { read: 'direct', edit: 'direct', create: 'direct' } }

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

describe('outils des presentations sur le pair', () => {
  it('lit le plan et regle transitions, decor et image de fond', async () => {
    backend.writeNote('v1', 'c', 'Cours.md', '---\ntype: slides\n---\n# Cours\n\n---\n\n## Partie 1\n\n- un\n- deux\n')
    const p = await ready()
    const tools = await p.call<{ tools: { name: string }[] }>('v1', 'tools', 'list')
    expect(tools.body.result.tools.map(t => t.name)).toEqual(expect.arrayContaining(['slides_outline', 'slides_style']))
    const outline = await call(p, 'slides_outline', { note: 'Cours' })
    expect(outline.text).toContain('2 diapositive(s)')
    expect(await call(p, 'slides_style', { note: 'Cours', transition: 'fondu', builds: true })).toMatchObject({ isError: false })
    expect(await call(p, 'slides_style', { note: 'Cours', slide: 2, decor: 'formes', image: 'photo.jpg', image_side: 'droite' })).toMatchObject({ isError: false })
    expect(backend.text('v1', 'c')).toBe('---\ntype: slides\ntransition: fondu\napparition: listes\n---\n# Cours\n\n---\n\n<!-- décor: formes -->\n![[photo.jpg|fond droite]]\n## Partie 1\n\n- un\n- deux\n')
  })
})
