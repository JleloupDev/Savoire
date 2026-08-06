// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// EdgesyncAwarenessChannel: peer cursor / presence over the same K_doc as a
// document's content, but deliberately NOT through Session — no HELLO, no
// history, just AEAD-encrypt-and-broadcast. Tested directly against the
// protocol's in-process transport (no relay/WebRTC needed: this channel only
// depends on ITransport + Keyring).
import { describe, it, expect } from 'vitest'
import { EdgesyncAwarenessChannel } from '@savoire/infrastructure-sync'
import { Bus, InProcessTransport, Keyring, randomBytes, resourceId } from 'edgesync-protocol'

const rand = () => randomBytes(32)
const settle = (ms = 20) => new Promise((r) => setTimeout(r, ms))

function makeChannel(id: string, bus: Bus, keyring: Keyring, resource: string): EdgesyncAwarenessChannel {
  const transport = new InProcessTransport(id, bus)
  transport.connect()
  return new EdgesyncAwarenessChannel({ resource, keyring, transport })
}

describe('EdgesyncAwarenessChannel', () => {
  it('broadcast/onUpdate : un pair qui partage le meme K_doc dechiffre la mise a jour', async () => {
    const bus = new Bus()
    const keyring = Keyring.genesis(rand)
    const rid = resourceId('vault-1/doc-1')
    keyring.mintDocKey(0, rid, rand)

    const a = makeChannel('A', bus, keyring, 'vault-1/doc-1')
    const b = makeChannel('B', bus, keyring, 'vault-1/doc-1')

    const received: Uint8Array[] = []
    b.onUpdate((bytes) => received.push(bytes))

    a.broadcast(new Uint8Array([1, 2, 3]))
    await settle()

    expect(received).toHaveLength(1)
    expect(received[0]).toEqual(new Uint8Array([1, 2, 3]))
  })

  it('une mise a jour pour une autre resource (autre document) est ignoree', async () => {
    const bus = new Bus()
    const keyring = Keyring.genesis(rand)
    const ridDoc1 = resourceId('vault-1/doc-1')
    const ridDoc2 = resourceId('vault-1/doc-2')
    keyring.mintDocKey(0, ridDoc1, rand)
    keyring.mintDocKey(0, ridDoc2, rand)

    const aDoc1 = makeChannel('A', bus, keyring, 'vault-1/doc-1')
    const bDoc2 = makeChannel('B', bus, keyring, 'vault-1/doc-2')

    const received: Uint8Array[] = []
    bDoc2.onUpdate((bytes) => received.push(bytes))

    aDoc1.broadcast(new Uint8Array([9]))
    await settle()

    expect(received).toHaveLength(0)
  })

  it('sans cle pour ce canal (pas encore accorde), broadcast() est un no-op silencieux', async () => {
    const bus = new Bus()
    const keyring = Keyring.empty() // no K_doc minted anywhere
    const a = makeChannel('A', bus, keyring, 'vault-1/doc-1')

    expect(() => a.broadcast(new Uint8Array([1]))).not.toThrow()
  })

  it('un frame chiffre sous une autre cle (K_doc different) est rejete silencieusement, pas de throw', async () => {
    const bus = new Bus()
    const keyringA = Keyring.genesis(rand)
    const rid = resourceId('vault-1/doc-1')
    keyringA.mintDocKey(0, rid, rand)

    const keyringB = Keyring.genesis(rand) // independent, different K_vault/K_doc
    keyringB.mintDocKey(0, rid, rand)

    const a = makeChannel('A', bus, keyringA, 'vault-1/doc-1')
    const b = makeChannel('B', bus, keyringB, 'vault-1/doc-1')

    const received: Uint8Array[] = []
    b.onUpdate((bytes) => received.push(bytes))

    expect(() => a.broadcast(new Uint8Array([1, 2, 3]))).not.toThrow()
    await settle()

    expect(received).toHaveLength(0)
  })

  it('dispose() desinscrit le handler onMessage', async () => {
    const bus = new Bus()
    const keyring = Keyring.genesis(rand)
    const rid = resourceId('vault-1/doc-1')
    keyring.mintDocKey(0, rid, rand)

    const a = makeChannel('A', bus, keyring, 'vault-1/doc-1')
    const b = makeChannel('B', bus, keyring, 'vault-1/doc-1')

    const received: Uint8Array[] = []
    b.onUpdate((bytes) => received.push(bytes))
    b.dispose()

    a.broadcast(new Uint8Array([1]))
    await settle()

    expect(received).toHaveLength(0)
  })
})
