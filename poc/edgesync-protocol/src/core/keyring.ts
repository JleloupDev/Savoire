// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Envelope key model (decision Q1). A vault key K_vault per epoch *wraps* a
// per-doc content key K_doc. Ops are encrypted under K_doc; K_doc is wrapped
// under K_vault and travels with the data. Because K_doc is wrapped (never
// derived), it stays independently sealable to an external peer (note sharing)
// without revealing K_vault. v0 advances the vault and doc epochs together;
// independent per-note rotation is deferred.
import { encrypt, decrypt } from './envelope'

export interface EpochKeys {
  epoch: number
  vaultKey: Uint8Array // K_vault^(epoch)
  docKey: Uint8Array // K_doc^(epoch)
  docWrap: Uint8Array // Enc(K_vault, K_doc), packed as nonce||ciphertext
}

const WRAP_NONCE = 24

function wrapDocKey(vaultKey: Uint8Array, docKey: Uint8Array): Uint8Array {
  const { nonce, ciphertext } = encrypt(vaultKey, docKey)
  const out = new Uint8Array(nonce.length + ciphertext.length)
  out.set(nonce)
  out.set(ciphertext, nonce.length)
  return out
}

function unwrapDocKey(vaultKey: Uint8Array, wrap: Uint8Array): Uint8Array {
  return decrypt(vaultKey, wrap.subarray(0, WRAP_NONCE), wrap.subarray(WRAP_NONCE))
}

export class Keyring {
  private readonly history = new Map<number, EpochKeys>()
  private current = -1

  private constructor() {}

  /** Genesis epoch (0). The founder/owner holds it first. */
  static genesis(rand: () => Uint8Array): Keyring {
    const kr = new Keyring()
    kr.mint(0, rand)
    return kr
  }

  /** An empty keyring for a peer that will receive keys via KEY messages. */
  static empty(): Keyring {
    return new Keyring()
  }

  private mint(epoch: number, rand: () => Uint8Array): EpochKeys {
    const vaultKey = rand()
    const docKey = rand()
    const keys: EpochKeys = { epoch, vaultKey, docKey, docWrap: wrapDocKey(vaultKey, docKey) }
    this.history.set(epoch, keys)
    if (epoch > this.current) this.current = epoch
    return keys
  }

  currentEpoch(): number {
    return this.current
  }

  docKey(epoch: number): Uint8Array | undefined {
    return this.history.get(epoch)?.docKey
  }

  vaultKey(epoch: number): Uint8Array | undefined {
    return this.history.get(epoch)?.vaultKey
  }

  has(epoch: number): boolean {
    return this.history.has(epoch)
  }

  /** Rotate to a fresh epoch (new K_vault + new K_doc). */
  rotate(rand: () => Uint8Array): EpochKeys {
    return this.mint(this.current + 1, rand)
  }

  /** Payload to deliver an epoch to a peer: vaultKey (caller seals it) + docWrap. */
  delivery(epoch: number): { vaultKey: Uint8Array; docWrap: Uint8Array } | undefined {
    const k = this.history.get(epoch)
    return k ? { vaultKey: k.vaultKey, docWrap: k.docWrap } : undefined
  }

  /** Import an epoch received via a KEY message (vaultKey already unsealed). */
  import(epoch: number, vaultKey: Uint8Array, docWrap: Uint8Array): void {
    if (this.history.has(epoch)) return
    const docKey = unwrapDocKey(vaultKey, docWrap)
    this.history.set(epoch, { epoch, vaultKey, docKey, docWrap })
    if (epoch > this.current) this.current = epoch
  }

  // Deferred extension — "logical vault" (a second security domain).
  // Today a content key (K_doc) is wrapped under exactly one K_vault: full
  // members get K_vault and read every channel; a single-channel guest gets just
  // K_doc via importDocKey() below and reads only that one — no group, no
  // independent revocation, but enough for "this peer may read this channel".
  //
  // The model also allows wrapping the SAME K_doc under a SECOND, independent
  // K_vault, so a separate group reads selected channels through their own vault
  // key — with membership, revocation and re-share managed independently of the
  // main vault. That is a "logical vault" living inside the session (a security
  // domain), and the content is still encrypted ONCE under K_doc (each domain
  // only adds another wrap of the key, never another ciphertext of the data).
  //
  // It only pays off for a MANAGED GROUP spanning several channels; for a lone
  // reader on a single channel it is pure overhead. Not implemented in v0 — we
  // keep one vault per session and use importDocKey() for per-channel reads. To
  // add it later: key wraps by (resourceId, epoch, domainId) instead of one
  // docWrap per epoch, and let delivery()/import() carry a domain's wrap set.

  /** Import a doc key shared directly (note sharing): no vault key involved. */
  importDocKey(epoch: number, docKey: Uint8Array): void {
    const existing = this.history.get(epoch)
    if (existing) return
    // A reader-only entry: docKey present, no vaultKey (cannot re-wrap or rotate).
    this.history.set(epoch, { epoch, vaultKey: new Uint8Array(0), docKey, docWrap: new Uint8Array(0) })
    if (epoch > this.current) this.current = epoch
  }

  /** Serialize the whole key history. A SECRET blob (it holds the keys). */
  serialize(): Uint8Array {
    const history = [...this.history.values()].map((k) => ({
      epoch: k.epoch,
      vaultKey: b64(k.vaultKey),
      docKey: b64(k.docKey),
      docWrap: b64(k.docWrap),
    }))
    return new TextEncoder().encode(JSON.stringify({ current: this.current, history }))
  }

  static deserialize(bytes: Uint8Array): Keyring {
    const obj = JSON.parse(new TextDecoder().decode(bytes))
    const kr = new Keyring()
    for (const e of obj.history) {
      kr.history.set(e.epoch, { epoch: e.epoch, vaultKey: ub64(e.vaultKey), docKey: ub64(e.docKey), docWrap: ub64(e.docWrap) })
    }
    kr.current = obj.current
    return kr
  }
}

const b64 = (u: Uint8Array): string => Buffer.from(u).toString('base64')
const ub64 = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, 'base64'))
