// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// documents.read : le texte d'une note, pour l'API ouverte du serveur.
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

describe('documents.read', () => {
  it('rend le texte exact d une note, par id ou par chemin', async () => {
    backend.writeNote('v1', 'a', 'Projets/Plan.md', '---\ntags: [x]\n---\n# Plan\n\n- [ ] etape **une**\n')
    backend.addFile('v1', 'f', 'Devis.sketch')
    backend.publishText('v1', 'f', 'montant 42')
    peer = await startPeer(backend, tmp.dir)
    await until(async () => (await peer!.status('v1')).body.status === 'ready', 10_000, 'construction')

    const byId = await peer.call<{ id: string; path: string; title: string; content: string; truncated: boolean }>('v1', 'documents', 'read', { id: 'a' })
    expect(byId.status).toBe(200)
    expect(byId.body.result).toEqual({ id: 'a', path: 'Projets/Plan.md', title: 'Plan', content: '---\ntags: [x]\n---\n# Plan\n\n- [ ] etape **une**\n', truncated: false })

    const byPath = await peer.call<{ id: string }>('v1', 'documents', 'read', { path: 'projets/plan.md' })
    expect(byPath.body.result.id).toBe('a')

    const file = await peer.call<{ content: string }>('v1', 'documents', 'read', { path: 'Devis.sketch' })
    expect(file.body.result.content).toBe('montant 42')
  })

  it('404 pour un document absent, 400 sans id ni chemin, 404 pour une autre methode', async () => {
    backend.writeNote('v1', 'a', 'A.md', 'texte')
    peer = await startPeer(backend, tmp.dir)
    await until(async () => (await peer!.status('v1')).body.status === 'ready', 10_000, 'construction')
    expect((await peer.call('v1', 'documents', 'read', { id: 'nope' })).status).toBe(404)
    expect((await peer.call('v1', 'documents', 'read', {})).status).toBe(400)
    expect((await peer.call('v1', 'documents', 'write', { id: 'a' })).status).toBe(404)
  })
})
