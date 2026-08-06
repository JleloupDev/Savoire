// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// EdgesyncWebRtcTransport: WebRTC DataChannel transport negotiated through the
// existing blind relay. A fake RTCPeerConnection/RTCDataChannel pair, wired
// through a shared registry, stands in for real WebRTC — the relay itself is
// the real FakeRelayServer used elsewhere, proving the signaling messages
// really do ride the same opaque channel as edgesync frames.
import { describe, it, expect, beforeEach } from 'vitest'
import { EdgesyncRelayTransport } from '@savoire/infrastructure-sync'
import { EdgesyncWebRtcTransport } from '@savoire/infrastructure-sync'
import { FakeRelayServer } from './fakeRelay'

const settle = (ms = 30) => new Promise((r) => setTimeout(r, ms))

// ── Fake WebRTC plumbing ─────────────────────────────────────────────────────

class FakeDataChannel {
  readyState: 'connecting' | 'open' | 'closed' = 'connecting'
  binaryType = ''
  onopen: (() => void) | null = null
  onmessage: ((ev: { data: ArrayBuffer }) => void) | null = null
  received: Uint8Array[] = []
  peer: FakeDataChannel | null = null
  closeCalls = 0

  send(data: unknown): void {
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data as ArrayBuffer)
    this.peer?.receive(bytes)
  }

  receive(bytes: Uint8Array): void {
    this.received.push(bytes)
    this.onmessage?.({ data: bytes.buffer as ArrayBuffer })
  }

  open(): void {
    this.readyState = 'open'
    this.onopen?.()
  }

  close(): void {
    this.closeCalls++
    this.readyState = 'closed'
  }
}

class SharedLink {
  offererDc: FakeDataChannel | null = null
}

const links = new Map<string, SharedLink>()
function linkFor(a: string, b: string): SharedLink {
  const key = [a, b].sort().join('|')
  let link = links.get(key)
  if (!link) { link = new SharedLink(); links.set(key, link) }
  return link
}

class FakePeerConnection {
  onicecandidate: ((ev: { candidate: null }) => void) | null = null
  ondatachannel: ((ev: { channel: FakeDataChannel }) => void) | null = null
  closeCalls = 0

  constructor(private readonly selfId: string, private readonly peerId: string) {}

  createDataChannel(_label: string): FakeDataChannel {
    const dc = new FakeDataChannel()
    linkFor(this.selfId, this.peerId).offererDc = dc
    return dc
  }

  async createOffer(): Promise<{ type: 'offer'; sdp: string }> {
    return { type: 'offer', sdp: 'fake-offer' }
  }

  async createAnswer(): Promise<{ type: 'answer'; sdp: string }> {
    return { type: 'answer', sdp: 'fake-answer' }
  }

  async setLocalDescription(): Promise<void> {}

  async setRemoteDescription(desc: { type: string }): Promise<void> {
    if (desc.type !== 'offer') return
    const link = linkFor(this.selfId, this.peerId)
    const offererDc = link.offererDc
    if (!offererDc) return
    const answererDc = new FakeDataChannel()
    offererDc.peer = answererDc
    answererDc.peer = offererDc
    offererDc.open()
    answererDc.open()
    this.ondatachannel?.({ channel: answererDc })
  }

  async addIceCandidate(): Promise<void> {}

  close(): void { this.closeCalls++ }
}

function fakePcFactoryFor(selfId: string, pcs: FakePeerConnection[]) {
  return (_config: RTCConfiguration, peerId: string): unknown => {
    const pc = new FakePeerConnection(selfId, peerId)
    pcs.push(pc)
    return pc
  }
}

async function makeTransport(localId: string, server: FakeRelayServer, pcs: FakePeerConnection[]) {
  // Force a deterministic connection id (for the tie-break assertions): it
  // must be consistent both locally (EdgesyncRelayTransport.localId reads it)
  // and as broadcast to the other peer (FakeRelayServer.join() uses the same
  // field for PeerUp) — overriding only the local getter would desync the two.
  const conn = server.attach()
  conn.connectionId = localId
  const relay = new EdgesyncRelayTransport({ connection: conn })
  const t = new EdgesyncWebRtcTransport({
    relay,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    rtcPeerConnectionFactory: fakePcFactoryFor(localId, pcs) as any,
  })
  return t
}

beforeEach(() => {
  links.clear()
})

describe('EdgesyncWebRtcTransport — negociation et bascule DataChannel/relais', () => {
  it('tie-break deterministe : seul le pair au localId lexicographiquement plus bas envoie l\'offre', async () => {
    const server = new FakeRelayServer()
    const pcsA: FakePeerConnection[] = []
    const pcsB: FakePeerConnection[] = []
    const a = await makeTransport('aaa', server, pcsA)
    const b = await makeTransport('bbb', server, pcsB)

    await a.connect('vault-1')
    await b.connect('vault-1')
    await settle(50)

    // 'aaa' < 'bbb': A offers (creates a DataChannel proactively), B only answers.
    expect(pcsA).toHaveLength(1)
    expect(pcsB).toHaveLength(1)
    expect(linkFor('aaa', 'bbb').offererDc).not.toBeNull()
  })

  it('une fois le DataChannel ouvert, send() le prefere au relais', async () => {
    const server = new FakeRelayServer()
    const pcsA: FakePeerConnection[] = []
    const pcsB: FakePeerConnection[] = []
    const a = await makeTransport('aaa', server, pcsA)
    const b = await makeTransport('bbb', server, pcsB)

    const bGotDirect: Uint8Array[] = []
    b.onMessage((_from, bytes) => bGotDirect.push(bytes))

    await a.connect('vault-1')
    await b.connect('vault-1')
    await settle(50)

    const dc = linkFor('aaa', 'bbb').offererDc!
    expect(dc.readyState).toBe('open')

    a.send('bbb', new Uint8Array([1, 2, 3]))

    // dc.peer (B's answerer channel) is what actually receives what A sends
    // over the DataChannel — proof the bytes went straight there, not the relay.
    expect(dc.peer?.received).toHaveLength(1)
    expect(bGotDirect).toHaveLength(1) // ...and reached B's onMessage
    expect(bGotDirect[0]).toEqual(new Uint8Array([1, 2, 3]))
  })

  it('sans RTCPeerConnection disponible, send() passe toujours par le relais (degrade proprement)', async () => {
    const server = new FakeRelayServer()
    const relayA = new EdgesyncRelayTransport({ connection: server.attach() })
    const relayB = new EdgesyncRelayTransport({ connection: server.attach() })
    const a = new EdgesyncWebRtcTransport({ relay: relayA, rtcPeerConnectionFactory: undefined })
    const b = new EdgesyncWebRtcTransport({ relay: relayB, rtcPeerConnectionFactory: undefined })

    const bGot: Uint8Array[] = []
    b.onMessage((_from, bytes) => bGot.push(bytes))

    await a.connect('vault-1')
    await b.connect('vault-1')
    await settle(30)

    a.send(b.localId, new Uint8Array([9]))
    await settle(30)

    expect(bGot).toHaveLength(1)
    expect(bGot[0]).toEqual(new Uint8Array([9]))
  })

  it('les messages de signaling ne fuient jamais vers onMessage (edgesync frames only)', async () => {
    const server = new FakeRelayServer()
    const pcsA: FakePeerConnection[] = []
    const pcsB: FakePeerConnection[] = []
    const a = await makeTransport('aaa', server, pcsA)
    const b = await makeTransport('bbb', server, pcsB)

    const bMessages: Uint8Array[] = []
    b.onMessage((_from, bytes) => bMessages.push(bytes))

    await a.connect('vault-1')
    await b.connect('vault-1')
    await settle(50)

    // Only real edgesync-shaped frames (never the offer/answer/ice signaling
    // exchanged during the settle() above) reached B's own onMessage.
    a.send('bbb', new Uint8Array([2, 0, 0, 0])) // looks like an OP frame (MsgType=2)
    await settle(10)

    expect(bMessages).toHaveLength(1)
    expect(bMessages[0][0]).toBe(2)
  })

  it('claimOwner est transmis au relais sous-jacent', async () => {
    const server = new FakeRelayServer()
    const pcsA: FakePeerConnection[] = []
    const pcsB: FakePeerConnection[] = []
    const a = await makeTransport('aaa', server, pcsA)
    const b = await makeTransport('bbb', server, pcsB)

    await a.connect('vault-1')
    await b.connect('vault-1')

    // Meme quand les deux essaient "en meme temps" (Promise.all), un seul
    // gagne — c'est exactement la course que ClaimOwner elimine cote serveur.
    const [aWon, bWon] = await Promise.all([a.claimOwner(), b.claimOwner()])
    expect([aWon, bWon].filter(Boolean)).toHaveLength(1)
  })

  it('dispose() ferme proprement le DataChannel et la PeerConnection, sans jeter', async () => {
    const server = new FakeRelayServer()
    const pcsA: FakePeerConnection[] = []
    const pcsB: FakePeerConnection[] = []
    const a = await makeTransport('aaa', server, pcsA)
    const b = await makeTransport('bbb', server, pcsB)

    await a.connect('vault-1')
    await b.connect('vault-1')
    await settle(50)

    await expect(a.close()).resolves.toBeUndefined()
    expect(pcsA[0].closeCalls).toBe(1)
  })
})
