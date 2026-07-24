// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// EdgesyncDocSession: the composition root of the vertical slice. Proves the
// owner rule (first connected peer of an empty room becomes the key holder)
// and that the app's OWN Y.Doc (the one the editor mutates) is what converges,
// E2E-encrypted, through the blind relay.
import { describe, it, expect } from 'vitest'
import * as Y from 'yjs'
import { EdgesyncDocSession, EdgesyncRelayTransport } from '@savoire/infrastructure-sync'
import { randomBytes } from 'edgesync-protocol'
import { FakeRelayServer } from './fakeRelay'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const Y_ = Y as Record<string, any>

const settle = (ms = 300) => new Promise((r) => setTimeout(r, ms))

function openOn(server: FakeRelayServer, doc: unknown, seed: Uint8Array) {
  return EdgesyncDocSession.open({
    vaultId: 'vault-1',
    docId: 'doc-1',
    identitySeed: seed,
    doc,
    transport: new EdgesyncRelayTransport({ connection: server.attach() }),
  })
}

describe('EdgesyncDocSession — slice verticale', () => {
  it('regle owner : premier connecte = detenteur de cle ; suivant = non', async () => {
    const server = new FakeRelayServer()
    const first = await openOn(server, new Y_.Doc(), randomBytes(32))
    const second = await openOn(server, new Y_.Doc(), randomBytes(32))

    expect(first.isOwner).toBe(true)
    expect(second.isOwner).toBe(false)

    first.dispose(); second.dispose()
  })

  it('le Y.Doc de l\'app converge E2E via le relais (champ codemirror)', async () => {
    const server = new FakeRelayServer()

    // A : le doc que "l'editeur" mutera, deja du contenu avant l'arrivee de B
    const docA = new Y_.Doc()
    docA.getText('codemirror').insert(0, 'note partagee')
    const a = await openOn(server, docA, randomBytes(32))

    // B : arrive apres, vide, recoit la cle puis l'etat
    const docB = new Y_.Doc()
    const b = await openOn(server, docB, randomBytes(32))
    await settle()

    expect(docB.getText('codemirror').toString()).toBe('note partagee')

    // edition cote B → A converge (le protocole route par resourceId)
    docB.getText('codemirror').insert(docB.getText('codemirror').length, ' + edit B')
    await settle(200)
    expect(docA.getText('codemirror').toString()).toBe('note partagee + edit B')

    a.dispose(); b.dispose()
  })
})
