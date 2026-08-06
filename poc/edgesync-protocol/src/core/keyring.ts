// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Envelope key model (decision Q1), generalized to a multi-channel vault. A
// vault key K_vault per epoch *wraps* N per-channel content keys K_doc, one
// per resourceId (a directory channel, plus one per document — see
// edgesync-local-client-v0-spec.md §4). Ops are encrypted under a channel's
// K_doc; K_doc is wrapped under K_vault and travels with the data. Because
// K_doc is wrapped (never derived), it stays independently sealable to an
// external peer (note sharing) without revealing K_vault. v0 advances the
// vault epoch and every known channel's doc epoch together; independent
// per-channel rotation is deferred.
import { encrypt, decrypt } from './envelope'
import { toBase64, fromBase64, toHex } from './codec'

interface DocEntry {
  docKey: Uint8Array // K_doc^(epoch) for this channel
  docWrap: Uint8Array // Enc(K_vault, K_doc), packed as nonce||ciphertext
}

interface EpochKeys {
  epoch: number
  vaultKey: Uint8Array // K_vault^(epoch) — empty for a reader-only (importDocKey) entry
  docs: Map<string, DocEntry> // key: hex(resourceId)
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

function eqBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const len = Math.min(a.length, b.length)
  for (let i = 0; i < len; i++) {
    if (a[i] !== b[i]) return a[i] - b[i]
  }
  return a.length - b.length
}

export class Keyring {
  private readonly history = new Map<number, EpochKeys>()
  private current = -1

  private constructor() {}

  /** Genesis epoch (0): mints K_vault only. No channel key exists yet — mint
   *  one per channel with mintDocKey() (the vault-directory channel first). */
  static genesis(rand: () => Uint8Array): Keyring {
    const kr = new Keyring()
    kr.history.set(0, { epoch: 0, vaultKey: rand(), docs: new Map() })
    kr.current = 0
    return kr
  }

  /** An empty keyring for a peer that will receive keys via KEY messages. */
  static empty(): Keyring {
    return new Keyring()
  }

  currentEpoch(): number {
    return this.current
  }

  vaultKey(epoch: number): Uint8Array | undefined {
    return this.history.get(epoch)?.vaultKey
  }

  has(epoch: number): boolean {
    return this.history.has(epoch)
  }

  /** Mint (or return if already minted) a channel's K_doc under this epoch's K_vault. Idempotent. */
  mintDocKey(epoch: number, resourceId: Uint8Array, rand: () => Uint8Array): Uint8Array {
    const e = this.history.get(epoch)
    if (!e || e.vaultKey.length === 0) throw new Error('mintDocKey: no K_vault at this epoch')
    const id = toHex(resourceId)
    const existing = e.docs.get(id)
    if (existing) return existing.docKey
    const docKey = rand()
    e.docs.set(id, { docKey, docWrap: wrapDocKey(e.vaultKey, docKey) })
    return docKey
  }

  docKey(epoch: number, resourceId: Uint8Array): Uint8Array | undefined {
    return this.history.get(epoch)?.docs.get(toHex(resourceId))?.docKey
  }

  /** resourceId of every channel known at this epoch (to build a full grant). */
  knownResources(epoch: number): Uint8Array[] {
    const e = this.history.get(epoch)
    if (!e) return []
    return [...e.docs.keys()].map(fromHexId)
  }

  /** Rotate to a fresh epoch: new K_vault, and a fresh K_doc (not a re-wrap)
   *  for every channel known at the previous epoch — forward-only. */
  rotate(rand: () => Uint8Array): { epoch: number } {
    const prev = this.history.get(this.current)
    const epoch = this.current + 1
    const vaultKey = rand()
    const e: EpochKeys = { epoch, vaultKey, docs: new Map() }
    this.history.set(epoch, e)
    this.current = epoch
    if (prev) {
      for (const [id] of prev.docs) {
        const docKey = rand()
        e.docs.set(id, { docKey, docWrap: wrapDocKey(vaultKey, docKey) })
      }
    }
    return { epoch }
  }

  /** Everything needed to grant a peer the whole vault known at this epoch. */
  delivery(epoch: number): { vaultKey: Uint8Array; docWraps: { resourceId: Uint8Array; docWrap: Uint8Array }[] } | undefined {
    const e = this.history.get(epoch)
    if (!e || e.vaultKey.length === 0) return undefined
    const docWraps = [...e.docs.entries()].map(([id, d]) => ({ resourceId: fromHexId(id), docWrap: d.docWrap }))
    return { vaultKey: e.vaultKey, docWraps }
  }

  /** Import a K_vault + a batch of docWraps received via KEY. Union with what
   *  is already known locally (new channels merged in; known ones untouched).
   *  Assumes at most one K_vault per epoch ever exists — guaranteed by the
   *  caller's election (e.g. EdgeSyncHub.ClaimOwner: server-arbitrated, at
   *  most one genesis winner per room), not by this layer.
   *
   *  A single resourceId's K_doc, unlike K_vault, has no equivalent election:
   *  ANY already-granting peer may legitimately mint a brand new channel's
   *  key on its own (§6.3, "possession of K_vault is the capacity to
   *  re-share") — there is no single designated "creator" to defer to, and
   *  for channels every member opens eagerly (e.g. an index namespace on
   *  vault activation) two peers racing to mint the SAME resourceId at
   *  nearly the same time is the common case, not an edge case. Reconciled
   *  here deterministically: since e.vaultKey is already shared (unwrapping
   *  never fails), compare the two resulting K_doc byte values directly and
   *  keep whichever is smaller — both sides reach the same verdict without
   *  any extra round-trip, no signature/identity needed. */
  import(epoch: number, vaultKey: Uint8Array, docWraps: { resourceId: Uint8Array; docWrap: Uint8Array }[]): void {
    let e = this.history.get(epoch)
    if (!e) {
      e = { epoch, vaultKey, docs: new Map() }
      this.history.set(epoch, e)
    } else if (e.vaultKey.length === 0) {
      e.vaultKey = vaultKey // upgrade a reader-only entry to a full member
    }
    for (const { resourceId, docWrap } of docWraps) {
      const id = toHex(resourceId)
      const existing = e.docs.get(id)
      if (existing) {
        const incomingKey = unwrapDocKey(e.vaultKey, docWrap)
        if (!eqBytes(existing.docKey, incomingKey) && compareBytes(incomingKey, existing.docKey) < 0) {
          e.docs.set(id, { docKey: incomingKey, docWrap })
        }
        continue
      }
      e.docs.set(id, { docKey: unwrapDocKey(e.vaultKey, docWrap), docWrap })
    }
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
  importDocKey(epoch: number, resourceId: Uint8Array, docKey: Uint8Array): void {
    let e = this.history.get(epoch)
    if (!e) {
      e = { epoch, vaultKey: new Uint8Array(0), docs: new Map() }
      this.history.set(epoch, e)
    }
    const id = toHex(resourceId)
    if (!e.docs.has(id)) e.docs.set(id, { docKey, docWrap: new Uint8Array(0) })
    if (epoch > this.current) this.current = epoch
  }

  /** Serialize the whole key history. A SECRET blob (it holds the keys). */
  serialize(): Uint8Array {
    const history = [...this.history.values()].map((e) => ({
      epoch: e.epoch,
      vaultKey: b64(e.vaultKey),
      docs: [...e.docs.entries()].map(([id, d]) => ({ resourceId: id, docKey: b64(d.docKey), docWrap: b64(d.docWrap) })),
    }))
    return new TextEncoder().encode(JSON.stringify({ current: this.current, history }))
  }

  static deserialize(bytes: Uint8Array): Keyring {
    const obj = JSON.parse(new TextDecoder().decode(bytes))
    const kr = new Keyring()
    for (const e of obj.history) {
      const docs = new Map<string, DocEntry>()
      for (const d of e.docs) docs.set(d.resourceId, { docKey: ub64(d.docKey), docWrap: ub64(d.docWrap) })
      kr.history.set(e.epoch, { epoch: e.epoch, vaultKey: ub64(e.vaultKey), docs })
    }
    kr.current = obj.current
    return kr
  }
}

const b64 = toBase64
const ub64 = fromBase64

function fromHexId(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16)
  return out
}
