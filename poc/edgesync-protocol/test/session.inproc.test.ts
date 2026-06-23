// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Integration: the protocol over the in-process transport. Pure P2P, no server.
import { describe, it, expect } from 'vitest'
import * as Y from 'yjs'
import {
  OwnIdentity, YjsCrdt, Bus, InProcessTransport, PeerStore, Session, Keyring, randomBytes,
  encrypt, signedRegion, encodeEnvelope, resourceId, concat, encodeHello, encodeKey, frame, MsgType,
} from '../src/index'

const RESOURCE = 'vault-1'
const rand = () => randomBytes(32)
const settle = (ms = 120) => new Promise((r) => setTimeout(r, ms))

function makePeer(id: string, bus: Bus, keyring: Keyring, granting: boolean) {
  const identity = OwnIdentity.generate()
  const crdt = new YjsCrdt()
  const transport = new InProcessTransport(id, bus)
  const session = new Session({ identity, crdt, keyring, transport, peers: new PeerStore(), resource: RESOURCE, granting })
  transport.connect()
  return { id, identity, crdt, keyring, transport, session, text: () => crdt.text().toString() }
}

function concatAll(chunks: Uint8Array[]): Uint8Array {
  let n = 0
  for (const c of chunks) n += c.length
  const out = new Uint8Array(n)
  let off = 0
  for (const c of chunks) {
    out.set(c, off)
    off += c.length
  }
  return out
}

function containsSub(hay: Uint8Array, needle: Uint8Array): boolean {
  outer: for (let i = 0; i + needle.length <= hay.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (hay[i + j] !== needle[j]) continue outer
    }
    return true
  }
  return false
}

describe('session — P2P chiffre (in-process)', () => {
  it('a+b: le fil ne porte que du chiffre, et deux pairs convergent', async () => {
    const bus = new Bus()
    const a = makePeer('A', bus, Keyring.genesis(rand), true)
    const b = makePeer('B', bus, Keyring.empty(), false)
    await settle()

    a.crdt.text().insert(0, 'SECRET')
    await settle()

    expect(b.text()).toBe('SECRET') // (b) convergence
    // (a) opacite : le mot clair n'apparait nulle part sur le fil
    expect(containsSub(concatAll(bus.wire), new TextEncoder().encode('SECRET'))).toBe(false)
  })

  it('c: merge a travers une rotation (pair offline re-key a la reconnexion)', async () => {
    const bus = new Bus()
    const a = makePeer('A', bus, Keyring.genesis(rand), true)
    const b = makePeer('B', bus, Keyring.empty(), false)
    await settle()
    a.crdt.text().insert(0, 'base ')
    await settle()
    expect(b.text()).toBe('base ')

    bus.disconnect('B')
    await settle()
    b.crdt.text().insert(b.crdt.text().length, 'B-offline')
    a.session.rotate() // B absent: l'epoque avance sans lui
    await settle()
    a.crdt.text().insert(a.crdt.text().length, ' A-new')
    await settle()

    b.transport.connect() // B revient
    await settle(300)

    expect(a.text()).toContain('B-offline')
    expect(b.text()).toContain('A-new')
    expect(a.text()).toBe(b.text())
  })

  it('d: pair revoque ne lit plus le futur et sa poussee perimee est rejetee', async () => {
    const bus = new Bus()
    const a = makePeer('A', bus, Keyring.genesis(rand), true)
    const b = makePeer('B', bus, Keyring.empty(), false)
    const c = makePeer('C', bus, Keyring.empty(), false)
    await settle()
    a.crdt.text().insert(0, 'shared ')
    await settle()
    expect(b.text()).toBe('shared ')
    expect(c.text()).toBe('shared ')

    a.session.revoke('C') // rotation, cle livree a B mais pas a C
    await settle()
    a.crdt.text().insert(a.crdt.text().length, 'after')
    await settle()

    expect(b.text()).toContain('after') // B continue de lire
    expect(c.text()).not.toContain('after') // C exclu du futur

    c.crdt.text().insert(c.crdt.text().length, 'C-illegal') // C ecrit en epoque perimee
    await settle()
    expect(a.text()).not.toContain('C-illegal')
    expect(b.text()).not.toContain('C-illegal')
  })

  it('d2: une op forgee en SYNC_RESP sous une epoque perimee est rejetee (anti-contournement)', async () => {
    const bus = new Bus()
    const a = makePeer('A', bus, Keyring.genesis(rand), true)
    const b = makePeer('B', bus, Keyring.empty(), false)
    const c = makePeer('C', bus, Keyring.empty(), false)
    await settle()
    a.crdt.text().insert(0, 'shared ')
    await settle()
    a.session.revoke('C')
    await settle()

    // B est a l'epoque 1 et garde la cle epoque 0 dans son historique ; C garde
    // aussi la cle epoque 0. C forge une op valide sous l'epoque 0 et l'encadre en
    // SYNC_RESP pour contourner le rejet d'epoque perimee.
    const oldKey = c.keyring.docKey(0)!
    const evil = new Y.Doc()
    evil.getText('message').insert(0, 'LAUNDERED')
    const update = Y.encodeStateAsUpdate(evil)
    const rid = resourceId(RESOURCE)
    const { nonce, ciphertext } = encrypt(oldKey, update)
    const sig = c.identity.sign(signedRegion(rid, 0, nonce, ciphertext))
    const env = encodeEnvelope({ resourceId: rid, epoch: 0, nonce, ciphertext, sig, signerPub: c.identity.signPub })
    c.transport.send('B', frame(MsgType.SyncResp, env))
    await settle()

    expect(b.text()).not.toContain('LAUNDERED') // le chemin SYNC_RESP ne contourne plus
  })

  it('f: un frame malforme est silencieusement rejete sans casser la session', async () => {
    const bus = new Bus()
    const a = makePeer('A', bus, Keyring.genesis(rand), true)
    const b = makePeer('B', bus, Keyring.empty(), false)
    await settle()
    a.crdt.text().insert(0, 'shared ')
    await settle()
    expect(b.text()).toBe('shared ')

    // Frames hostiles vers B : vide, JSON casse en HELLO, enveloppe tronquee,
    // type inconnu. Aucun ne doit lever ni interrompre la session de B.
    a.transport.send('B', new Uint8Array(0))
    a.transport.send('B', frame(MsgType.Hello, new TextEncoder().encode('{ not json')))
    a.transport.send('B', frame(MsgType.Op, new Uint8Array(10)))
    a.transport.send('B', frame(99 as MsgType, new Uint8Array([1, 2, 3])))
    await settle()

    // B survit : il accepte encore une op legitime apres les frames hostiles.
    a.crdt.text().insert(a.crdt.text().length, 'still-alive')
    await settle()
    expect(b.text()).toBe('shared still-alive')
  })

  it('b1: une op signee par une identite inconnue est rejetee (utilisateur non epingle)', async () => {
    const bus = new Bus()
    const a = makePeer('A', bus, Keyring.genesis(rand), true)
    const b = makePeer('B', bus, Keyring.empty(), false)
    await settle()
    a.crdt.text().insert(0, 'shared ')
    await settle()
    expect(b.text()).toBe('shared ')

    // Z detient la cle de doc (fuite simulee) mais n'a jamais fait de handshake.
    const z = OwnIdentity.generate()
    const epoch = b.keyring.currentEpoch()
    const key = b.keyring.docKey(epoch)!
    const evil = new Y.Doc()
    evil.getText('message').insert(0, 'INTRUS')
    const update = Y.encodeStateAsUpdate(evil)
    const rid = resourceId(RESOURCE)
    const { nonce, ciphertext } = encrypt(key, update)
    const sig = z.sign(signedRegion(rid, epoch, nonce, ciphertext))
    const env = encodeEnvelope({ resourceId: rid, epoch, nonce, ciphertext, sig, signerPub: z.signPub })
    a.transport.send('B', frame(MsgType.Op, env)) // relayee, mais signee par Z

    await settle()
    expect(b.text()).not.toContain('INTRUS') // Z n'est pas un utilisateur epingle
  })

  it('g (#2): une op valide mais pour un autre canal (resourceId) est rejetee', async () => {
    const bus = new Bus()
    const a = makePeer('A', bus, Keyring.genesis(rand), true)
    const b = makePeer('B', bus, Keyring.empty(), false)
    await settle()
    a.crdt.text().insert(0, 'shared ')
    await settle()
    expect(b.text()).toBe('shared ')

    // A (epingle) signe une op parfaitement valide AVEC la bonne cle, mais pour un
    // autre resourceId. Seul le canal differe : B doit la jeter au demux.
    const epoch = b.keyring.currentEpoch()
    const key = b.keyring.docKey(epoch)!
    const otherRid = resourceId('autre-canal')
    const evil = new Y.Doc()
    evil.getText('message').insert(0, 'WRONGCHAN')
    const update = Y.encodeStateAsUpdate(evil)
    const { nonce, ciphertext } = encrypt(key, update)
    const sig = a.identity.sign(signedRegion(otherRid, epoch, nonce, ciphertext))
    const env = encodeEnvelope({ resourceId: otherRid, epoch, nonce, ciphertext, sig, signerPub: a.identity.signPub })
    a.transport.send('B', frame(MsgType.Op, env))
    await settle()
    expect(b.text()).not.toContain('WRONGCHAN')
  })

  it('h (#4): un HELLO dont le boxPub est substitue est rejete (pas de grant)', async () => {
    const bus = new Bus()
    const a = makePeer('A', bus, Keyring.genesis(rand), true)
    await settle()

    // M est un transport brut (pas de Session) qui forge un HELLO : il signe le
    // transcript avec le VRAI boxPub d'une victime, puis envoie un boxPub pirate.
    const m = new InProcessTransport('M', bus)
    const received: number[] = []
    m.onMessage((_from, bytes) => received.push(bytes[0]))
    m.connect()
    await settle()

    const victim = OwnIdentity.generate()
    const evilBox = OwnIdentity.generate().boxPub
    const nonce = randomBytes(24)
    const rid = resourceId(RESOURCE)
    const transcript = concat(new Uint8Array([1]), victim.signPub, victim.boxPub, rid, nonce)
    const sig = victim.sign(transcript)
    m.send('A', frame(MsgType.Hello, encodeHello({ signPub: victim.signPub, boxPub: evilBox, nonce, sig })))
    await settle()

    // A verifie le transcript avec evilBox -> signature invalide -> aucune KEY emise.
    expect(received).not.toContain(MsgType.Key)
  })

  it('i (#3): une KEY signee par un grantor non epingle est rejetee', async () => {
    const bus = new Bus()
    const x = makePeer('X', bus, Keyring.empty(), false)
    await settle()
    expect(x.keyring.currentEpoch()).toBe(-1)

    // M (transport brut, jamais de handshake valide avec X) forge une KEY adressee
    // a X, en pretendant venir d'un grantor G que X n'a jamais epingle.
    const m = new InProcessTransport('M', bus)
    m.connect()
    await settle()

    const g = OwnIdentity.generate()
    m.send('X', frame(MsgType.Key, encodeKey({
      resource: RESOURCE, epoch: 0, sealedVaultKey: randomBytes(48), docWrap: randomBytes(40),
      grantorSignPub: g.signPub, recipientSignPub: x.identity.signPub, sig: randomBytes(64),
    })))
    await settle()

    expect(x.keyring.currentEpoch()).toBe(-1) // X n'a importe aucune epoque
  })
})
