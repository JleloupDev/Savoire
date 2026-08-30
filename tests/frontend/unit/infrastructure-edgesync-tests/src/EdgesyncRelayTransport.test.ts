// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// EdgesyncRelayTransport: the edgesync ITransport over the blind relay hub.
// Part 1 checks the transport contract against a fake connection. Part 2 wires
// two transports through an in-memory fake relay and runs two REAL protocol
// Sessions over them: if they converge E2E-encrypted, the transport honours
// everything the protocol needs (introduction, addressed frames, presence).
import { describe, it, expect } from 'vitest'
import { EdgesyncRelayTransport, type RelayConnection } from '@savoire/infrastructure-edgesync'
import {
  OwnIdentity, YjsCrdt, PeerStore, Session, Keyring, randomBytes, toBase64, resourceId,
} from 'edgesync-protocol'
import { FakeRelayServer } from './fakeRelay'

const settle = (ms = 150) => new Promise((r) => setTimeout(r, ms))

// ── Part 1: contract against a fake connection ───────────────────────────────

type Handler = (...args: string[]) => void

class FakeConnection implements RelayConnection {
  connectionId: string | null = null
  started = false
  readonly handlers = new Map<string, Handler>()
  readonly invocations: { method: string; args: unknown[] }[] = []
  joinResult: string[] = []
  claimOwnerResult = true
  private reconnectedCb: ((connectionId?: string) => void) | null = null
  private closeCb: ((error?: Error) => void) | null = null

  on(method: string, cb: (...args: never[]) => void): void {
    this.handlers.set(method, cb as Handler)
  }

  async invoke<T>(method: string, ...args: unknown[]): Promise<T> {
    this.invocations.push({ method, args })
    if (method === 'Join') return this.joinResult as T
    if (method === 'ClaimOwner') return this.claimOwnerResult as T
    return undefined as T
  }

  async start(): Promise<void> {
    this.started = true
    this.connectionId = 'me'
  }

  async stop(): Promise<void> {
    this.started = false
  }

  onreconnected(cb: (connectionId?: string) => void): void {
    this.reconnectedCb = cb
  }

  onclose(cb: (error?: Error) => void): void {
    this.closeCb = cb
  }

  fire(method: string, ...args: string[]): void {
    this.handlers.get(method)?.(...args)
  }

  fireReconnected(): void {
    this.reconnectedCb?.()
  }

  fireClose(): void {
    this.closeCb?.()
  }
}

describe('EdgesyncRelayTransport — contrat', () => {
  async function make(joinResult: string[] = []) {
    const conn = new FakeConnection()
    conn.joinResult = joinResult
    const t = new EdgesyncRelayTransport({ connection: conn })
    return { conn, t }
  }

  it('connect: demarre, rejoint le vault, annonce les pairs deja presents', async () => {
    const { conn, t } = await make(['p1', 'p2'])
    const ups: string[] = []
    t.onPeerUp((id) => ups.push(id))

    await t.connect('vault-1')

    expect(conn.started).toBe(true)
    expect(conn.invocations[0]).toEqual({ method: 'Join', args: ['vault-1'] })
    expect(ups.sort()).toEqual(['p1', 'p2'])
    expect(t.peers().sort()).toEqual(['p1', 'p2'])
    expect(t.localId).toBe('me')
  })

  it('Frame: decode le base64 et route vers onMessage; autre vault ignore', async () => {
    const { conn, t } = await make()
    await t.connect('vault-1')
    const got: { from: string; bytes: Uint8Array }[] = []
    t.onMessage((from, bytes) => got.push({ from, bytes }))

    const payload = new Uint8Array([1, 2, 3])
    conn.fire('Frame', 'vault-1', 'p9', toBase64(payload))
    conn.fire('Frame', 'autre-vault', 'p9', toBase64(payload))
    conn.fire('Frame', 'vault-1', 'p9', '%%%invalid%%%')

    expect(got).toHaveLength(1)
    expect(got[0].from).toBe('p9')
    expect(got[0].bytes).toEqual(payload)
  })

  it('PeerUp/PeerDown: met a jour peers() et notifie', async () => {
    const { conn, t } = await make()
    await t.connect('vault-1')
    const downs: string[] = []
    t.onPeerDown((id) => downs.push(id))

    conn.fire('PeerUp', 'vault-1', 'p1')
    expect(t.peers()).toEqual(['p1'])
    conn.fire('PeerDown', 'vault-1', 'p1')
    expect(t.peers()).toEqual([])
    expect(downs).toEqual(['p1'])
  })

  it('send: relaie en base64 vers le pair vise', async () => {
    const { conn, t } = await make()
    await t.connect('vault-1')

    t.send('p1', new Uint8Array([9, 8]))
    await settle(10)

    const relay = conn.invocations.find((i) => i.method === 'Relay')
    expect(relay?.args).toEqual(['vault-1', 'p1', toBase64(new Uint8Array([9, 8]))])
  })

  it('onreconnected : re-Join et reconcilie la presence (PeerDown pour les absents, PeerUp pour les nouveaux)', async () => {
    const { conn, t } = await make(['p1', 'p2'])
    const ups: string[] = []
    const downs: string[] = []
    t.onPeerUp((id) => ups.push(id))
    t.onPeerDown((id) => downs.push(id))
    await t.connect('vault-1')
    expect(t.peers().sort()).toEqual(['p1', 'p2'])

    // Apres reconnexion : p1 a disparu, p3 est nouveau, p2 est toujours la.
    conn.joinResult = ['p2', 'p3']
    conn.fireReconnected()
    await settle(10)

    expect(t.peers().sort()).toEqual(['p2', 'p3'])
    expect(downs).toEqual(['p1'])
    expect(ups).toEqual(['p1', 'p2', 'p3']) // p1,p2 du join initial, p3 du reconnect
  })

  it('claimOwner : invoque ClaimOwner sur le vault courant et renvoie le verdict du serveur', async () => {
    const { conn, t } = await make()
    await t.connect('vault-1')

    conn.claimOwnerResult = false
    await expect(t.claimOwner()).resolves.toBe(false)
    expect(conn.invocations.at(-1)).toEqual({ method: 'ClaimOwner', args: ['vault-1'] })
  })

  it('onclose : tous les pairs presents sont annonces absents', async () => {
    const { conn, t } = await make(['p1', 'p2'])
    const downs: string[] = []
    t.onPeerDown((id) => downs.push(id))
    await t.connect('vault-1')

    conn.fireClose()

    expect(t.peers()).toEqual([])
    expect(downs.sort()).toEqual(['p1', 'p2'])
  })
})

// ── Part 2: deux Sessions REELLES du protocole a travers un faux relais ──────

describe('EdgesyncRelayTransport — deux Sessions protocole convergent via le relais', () => {
  it('handshake, remise de cle et sync E2E chiffree a travers le relais', async () => {
    const server = new FakeRelayServer()
    const rand = () => randomBytes(32)

    // A: fondateur (genesis, granting) — deja dans la room
    const crdtA = new YjsCrdt()
    const transportA = new EdgesyncRelayTransport({ connection: server.attach() })
    const keyringA = Keyring.genesis(rand)
    keyringA.mintDocKey(0, resourceId('vault-1/doc-1'), rand)
    new Session({
      identity: OwnIdentity.generate(), crdt: crdtA, keyring: keyringA,
      transport: transportA, peers: new PeerStore(), resource: 'vault-1/doc-1', granting: true,
    })
    await transportA.connect('vault-1')
    crdtA.text().insert(0, 'hello par relais')

    // B: nouvel arrivant, keyring vide
    const crdtB = new YjsCrdt()
    const transportB = new EdgesyncRelayTransport({ connection: server.attach() })
    new Session({
      identity: OwnIdentity.generate(), crdt: crdtB, keyring: Keyring.empty(),
      transport: transportB, peers: new PeerStore(), resource: 'vault-1/doc-1', granting: false,
    })
    await transportB.connect('vault-1')

    await settle(300) // HELLO + KEY + SYNC via microtasks du faux relais

    expect(crdtB.text().toString()).toBe('hello par relais')

    // et la convergence continue dans l'autre sens
    crdtB.text().insert(crdtB.text().length, ' + retour B')
    await settle(200)
    expect(crdtA.text().toString()).toBe('hello par relais + retour B')
  })
})
