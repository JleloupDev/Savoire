// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// The Keyring multi-channel extension (spec §4): one Keyring shared by
// reference across several Sessions of the same vault. Only the
// vault-directory Session does KEY exchange; document Sessions read the
// already-populated shared Keyring and never see a KEY themselves.
import { describe, it, expect } from 'vitest'
import {
  OwnIdentity, YjsCrdt, Bus, InProcessTransport, PeerStore, Session, Keyring, randomBytes, resourceId,
  encodeKey, encodeHello, frame, MsgType, seal, concat,
} from '../src/index'

const VAULT = 'vault-multi'
const RID_DIR = resourceId(`${VAULT}/dir`)
const RID_DOC1 = resourceId(`${VAULT}/doc/1`)
const RID_DOC2 = resourceId(`${VAULT}/doc/2`)

const rand = () => randomBytes(32)
const settle = (ms = 120) => new Promise((r) => setTimeout(r, ms))

interface Peer {
  id: string
  identity: OwnIdentity
  keyring: Keyring
  peers: PeerStore
  transport: InProcessTransport
  dir: Session
  docs: Map<string, { session: Session; crdt: YjsCrdt }>
}

function openDoc(p: Peer, docId: string, _rid: Uint8Array): { session: Session; crdt: YjsCrdt } {
  const crdt = new YjsCrdt()
  const session = new Session({
    identity: p.identity, crdt, keyring: p.keyring, transport: p.transport, peers: p.peers,
    resource: `${VAULT}/doc/${docId}`, granting: false,
  })
  p.docs.set(docId, { session, crdt })
  return { session, crdt }
}

function makePeer(id: string, bus: Bus, keyring: Keyring, granting: boolean): Peer {
  const identity = OwnIdentity.generate()
  const peers = new PeerStore()
  const transport = new InProcessTransport(id, bus)
  const dir = new Session({
    identity, crdt: new YjsCrdt(), keyring, transport, peers, resource: `${VAULT}/dir`, granting,
  })
  transport.connect()
  return { id, identity, keyring, peers, transport, dir, docs: new Map() }
}

function u32be(n: number): Uint8Array {
  const b = new Uint8Array(4)
  new DataView(b.buffer).setUint32(0, n, false)
  return b
}

describe('vault multi-canal — un Keyring partage, un seul echange KEY sur le repertoire', () => {
  it('le grant sur le canal directory suffit a debloquer plusieurs canaux document (aucune Session document n\'echange de KEY)', async () => {
    const bus = new Bus()

    const founderKeyring = Keyring.genesis(rand)
    founderKeyring.mintDocKey(0, RID_DIR, rand)
    founderKeyring.mintDocKey(0, RID_DOC1, rand)
    founderKeyring.mintDocKey(0, RID_DOC2, rand)
    const a = makePeer('A', bus, founderKeyring, true)
    const b = makePeer('B', bus, Keyring.empty(), false)
    await settle() // A grants B the whole vault (dir + doc1 + doc2) via ONE KeyMsg on the dir channel

    expect(b.keyring.docKey(0, RID_DIR)).toBeDefined()
    expect(b.keyring.docKey(0, RID_DOC1)).toBeDefined()
    expect(b.keyring.docKey(0, RID_DOC2)).toBeDefined()

    // Document Sessions never receive a KEY themselves: opening them now, they
    // read straight off the shared Keyring already populated by the dir grant.
    const aDoc1 = openDoc(a, '1', RID_DOC1)
    const bDoc1 = openDoc(b, '1', RID_DOC1)
    const aDoc2 = openDoc(a, '2', RID_DOC2)
    const bDoc2 = openDoc(b, '2', RID_DOC2)

    aDoc1.crdt.text().insert(0, 'doc one content')
    aDoc2.crdt.text().insert(0, 'doc two content')
    await settle()

    expect(bDoc1.crdt.text().toString()).toBe('doc one content')
    expect(bDoc2.crdt.text().toString()).toBe('doc two content')
  })

  it('un document cree APRES connexion est accorde automatiquement aux pairs deja presents', async () => {
    const bus = new Bus()

    const founderKeyring = Keyring.genesis(rand)
    founderKeyring.mintDocKey(0, RID_DIR, rand)
    const a = makePeer('A', bus, founderKeyring, true)
    const b = makePeer('B', bus, Keyring.empty(), false)
    await settle() // B is granted the dir-only vault so far

    expect(b.keyring.docKey(0, RID_DOC1)).toBeUndefined()

    // A mints a brand new channel and, per §6.3, pushes an updated grant to
    // every already-connected peer over the directory Session.
    a.keyring.mintDocKey(0, RID_DOC1, rand)
    for (const peer of a.transport.peers()) a.dir.grantPeer(peer)
    await settle()

    expect(b.keyring.docKey(0, RID_DOC1)).toEqual(a.keyring.docKey(0, RID_DOC1))

    // The new channel converges without B's document Session ever doing a KEY exchange.
    const aDoc1 = openDoc(a, '1', RID_DOC1)
    const bDoc1 = openDoc(b, '1', RID_DOC1)
    aDoc1.crdt.text().insert(0, 'fresh doc')
    await settle()
    expect(bDoc1.crdt.text().toString()).toBe('fresh doc')
  })

  it('une signature de grant qui ne couvre qu\'un sous-ensemble des docWraps annonces est rejetee', async () => {
    const bus = new Bus()
    const c = makePeer('C', bus, Keyring.empty(), false)
    await settle()
    expect(c.keyring.currentEpoch()).toBe(-1)

    // M is a raw transport (no Session) forging a legitimate-looking HELLO from
    // a "grantor" identity g, so C pins g via normal TOFU.
    const m = new InProcessTransport('M', bus)
    m.connect()
    await settle()

    const g = OwnIdentity.generate()
    const nonce = randomBytes(24)
    const helloTranscript = concat(new Uint8Array([1]), g.signPub, g.boxPub, RID_DIR, nonce)
    m.send('C', frame(MsgType.Hello, encodeHello({ signPub: g.signPub, boxPub: g.boxPub, nonce, sig: g.sign(helloTranscript) })))
    await settle()

    // A legitimate two-channel grant, as g would actually produce it.
    const gKeyring = Keyring.genesis(rand)
    gKeyring.mintDocKey(0, RID_DIR, rand)
    gKeyring.mintDocKey(0, RID_DOC1, rand)
    const delivery = gKeyring.delivery(0)!
    const sealedVaultKey = seal(c.identity.boxPub, delivery.vaultKey)

    // Attack: sign a region covering only the FIRST docWrap, but send the
    // message with BOTH docWraps attached (recombination / partial coverage).
    const subsetRegion = concat(
      RID_DIR, u32be(0), c.identity.signPub, sealedVaultKey,
      delivery.docWraps[0].resourceId, delivery.docWraps[0].docWrap,
    )
    const sig = g.sign(subsetRegion)

    m.send('C', frame(MsgType.Key, encodeKey({
      resource: `${VAULT}/dir`, epoch: 0, sealedVaultKey, docWraps: delivery.docWraps,
      grantorSignPub: g.signPub, recipientSignPub: c.identity.signPub, sig,
    })))
    await settle()

    expect(c.keyring.currentEpoch()).toBe(-1) // rejected: sig didn't cover the full docWraps batch
  })
})
