// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Peer identity: two keypairs, never one. Ed25519 signs (authenticity of the
// author); X25519 wraps (confidentiality to a public key). Pure, no I/O.
import { ed25519, x25519 } from '@noble/curves/ed25519'
import { sha256 } from '@noble/hashes/sha2'
import { randomBytes, seal, unseal, concat } from './envelope'

// Domain separator for deriving the box seed from a signing seed (fromSignSeed).
const BOX_DERIVE_TAG = new TextEncoder().encode('edgesync-box-v1')

/** The public identity of a peer. */
export interface PeerIdentity {
  readonly signPub: Uint8Array
  readonly boxPub: Uint8Array
}

/** A peer's own identity, holding the private halves. */
export class OwnIdentity implements PeerIdentity {
  private constructor(
    private readonly signPriv: Uint8Array,
    private readonly boxPriv: Uint8Array,
    readonly signPub: Uint8Array,
    readonly boxPub: Uint8Array,
  ) {}

  static generate(): OwnIdentity {
    // Ed25519/X25519 private keys are 32 random bytes (seed / clamped scalar).
    const signPriv = randomBytes(32)
    const boxPriv = randomBytes(32)
    return new OwnIdentity(signPriv, boxPriv, ed25519.getPublicKey(signPriv), x25519.getPublicKey(boxPriv))
  }

  /**
   * Deterministic identity from a single Ed25519 signing seed: the box seed is
   * derived as sha256(seed ‖ tag). Lets an app that already provisions one
   * signing key per user (e.g. a server-side key provider) obtain the SAME
   * edgesync identity on every device. v0 trade-off: the box key is bound to
   * the signing seed by a one-way hash instead of being stored separately.
   */
  static fromSignSeed(signSeed: Uint8Array): OwnIdentity {
    if (signSeed.length !== 32) throw new Error('fromSignSeed: expected a 32-byte seed')
    const boxPriv = sha256(concat(signSeed, BOX_DERIVE_TAG))
    return new OwnIdentity(signSeed, boxPriv, ed25519.getPublicKey(signSeed), x25519.getPublicKey(boxPriv))
  }

  /** Serialize the private halves (signPriv ‖ boxPriv). A SECRET blob. */
  serialize(): Uint8Array {
    return concat(this.signPriv, this.boxPriv)
  }

  static deserialize(bytes: Uint8Array): OwnIdentity {
    const signPriv = bytes.subarray(0, 32)
    const boxPriv = bytes.subarray(32, 64)
    return new OwnIdentity(signPriv, boxPriv, ed25519.getPublicKey(signPriv), x25519.getPublicKey(boxPriv))
  }

  sign(msg: Uint8Array): Uint8Array {
    return ed25519.sign(msg, this.signPriv)
  }

  /** Decrypt a value sealed to our box public key. */
  unseal(sealed: Uint8Array): Uint8Array {
    return unseal(this.boxPriv, sealed)
  }

  get public(): PeerIdentity {
    return { signPub: this.signPub, boxPub: this.boxPub }
  }
}

export function verify(sig: Uint8Array, msg: Uint8Array, signPub: Uint8Array): boolean {
  try {
    return ed25519.verify(sig, msg, signPub)
  } catch {
    return false
  }
}

/** Seal a value to a recipient peer's box public key (note sharing, key wrap). */
export function sealTo(recipient: PeerIdentity, plaintext: Uint8Array): Uint8Array {
  return seal(recipient.boxPub, plaintext)
}
