// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Magasin de cles des pairs (security-channel-model.md, §1.5.1): the public key
// of a peer is local, pinnable state. v0 policy is TOFU; S3/S4 only change the
// policy on this same data, not its shape.
import type { PeerIdentity } from '../core/identity'

export type PeerStatus = 'pinned' | 'verified-oob'

export interface KnownPeer extends PeerIdentity {
  status: PeerStatus
  pinnedAt: number
}

export class PeerStore {
  private readonly peers = new Map<string, KnownPeer>()
  private readonly signers = new Set<string>() // hex(signPub) of pinned peers

  /** Trust on first use: pin the key the first time, alert on any later change. */
  observe(id: string, identity: PeerIdentity): KnownPeer {
    const existing = this.peers.get(id)
    if (!existing) {
      const pinned: KnownPeer = { signPub: identity.signPub, boxPub: identity.boxPub, status: 'pinned', pinnedAt: Date.now() }
      this.peers.set(id, pinned)
      this.signers.add(hex(identity.signPub))
      return pinned
    }
    if (!bytesEqual(existing.signPub, identity.signPub) || !bytesEqual(existing.boxPub, identity.boxPub)) {
      throw new Error(`peer ${id}: pinned key changed (possible MITM)`)
    }
    return existing
  }

  get(id: string): KnownPeer | undefined {
    return this.peers.get(id)
  }

  /** Is this signing key a pinned user? (B1 author check — no rights yet.) */
  knowsSigner(signPub: Uint8Array): boolean {
    return this.signers.has(hex(signPub))
  }

  /** Serialize pinned peers. NOT secret (public keys only). */
  serialize(): Uint8Array {
    const peers = [...this.peers.entries()].map(([id, p]) => ({
      id,
      signPub: b64(p.signPub),
      boxPub: b64(p.boxPub),
      status: p.status,
      pinnedAt: p.pinnedAt,
    }))
    return new TextEncoder().encode(JSON.stringify({ peers }))
  }

  static deserialize(bytes: Uint8Array): PeerStore {
    const store = new PeerStore()
    const obj = JSON.parse(new TextDecoder().decode(bytes))
    for (const p of obj.peers) {
      const known: KnownPeer = { signPub: ub64(p.signPub), boxPub: ub64(p.boxPub), status: p.status, pinnedAt: p.pinnedAt }
      store.peers.set(p.id, known)
      store.signers.add(hex(known.signPub))
    }
    return store
  }
}

function hex(u: Uint8Array): string {
  return Buffer.from(u).toString('hex')
}
const b64 = (u: Uint8Array): string => Buffer.from(u).toString('base64')
const ub64 = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, 'base64'))

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}
