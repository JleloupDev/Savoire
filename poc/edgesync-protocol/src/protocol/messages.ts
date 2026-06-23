// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Wire messages. Framed as [type:1][payload]. OP / SYNC_RESP payloads are raw
// envelopes (binary); control messages (HELLO / KEY / SYNC_REQ) are JSON.

export enum MsgType {
  Hello = 1,
  Op = 2,
  Key = 3,
  SyncReq = 4,
  SyncResp = 5,
}

export function frame(type: MsgType, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(1 + payload.length)
  out[0] = type
  out.set(payload, 1)
  return out
}

export function unframe(bytes: Uint8Array): { type: MsgType; payload: Uint8Array } {
  if (bytes.length < 1) throw new Error('empty frame')
  return { type: bytes[0] as MsgType, payload: bytes.subarray(1) }
}

const enc = new TextEncoder()
const dec = new TextDecoder()
const b64 = (u: Uint8Array): string => Buffer.from(u).toString('base64')
const ub64 = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, 'base64'))

export interface HelloMsg {
  signPub: Uint8Array
  boxPub: Uint8Array
  nonce: Uint8Array
  sig: Uint8Array
}

export function encodeHello(m: HelloMsg): Uint8Array {
  return enc.encode(JSON.stringify({ signPub: b64(m.signPub), boxPub: b64(m.boxPub), nonce: b64(m.nonce), sig: b64(m.sig) }))
}

export function decodeHello(p: Uint8Array): HelloMsg {
  const o = JSON.parse(dec.decode(p))
  return { signPub: ub64(o.signPub), boxPub: ub64(o.boxPub), nonce: ub64(o.nonce), sig: ub64(o.sig) }
}

export interface KeyMsg {
  resource: string
  epoch: number
  sealedVaultKey: Uint8Array
  docWrap: Uint8Array
  /** Signing key of the grantor; must be a pinned peer on receipt. */
  grantorSignPub: Uint8Array
  /** Signing key of the intended recipient; binds the grant to one peer. */
  recipientSignPub: Uint8Array
  /** Grantor signature over the grant region (see Session.keyGrantRegion). */
  sig: Uint8Array
}

export function encodeKey(m: KeyMsg): Uint8Array {
  return enc.encode(JSON.stringify({
    resource: m.resource, epoch: m.epoch, sealedVaultKey: b64(m.sealedVaultKey), docWrap: b64(m.docWrap),
    grantorSignPub: b64(m.grantorSignPub), recipientSignPub: b64(m.recipientSignPub), sig: b64(m.sig),
  }))
}

export function decodeKey(p: Uint8Array): KeyMsg {
  const o = JSON.parse(dec.decode(p))
  return {
    resource: o.resource, epoch: o.epoch, sealedVaultKey: ub64(o.sealedVaultKey), docWrap: ub64(o.docWrap),
    grantorSignPub: ub64(o.grantorSignPub), recipientSignPub: ub64(o.recipientSignPub), sig: ub64(o.sig),
  }
}

export interface SyncReqMsg {
  resourceId: Uint8Array
  stateVector: Uint8Array
}

export function encodeSyncReq(m: SyncReqMsg): Uint8Array {
  return enc.encode(JSON.stringify({ resourceId: b64(m.resourceId), stateVector: b64(m.stateVector) }))
}

export function decodeSyncReq(p: Uint8Array): SyncReqMsg {
  const o = JSON.parse(dec.decode(p))
  return { resourceId: ub64(o.resourceId), stateVector: ub64(o.stateVector) }
}
