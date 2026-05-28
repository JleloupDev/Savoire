// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import { describe, it, expect } from 'vitest'
import { encodeSignedOp, decodeSignedOp } from '@savoire/plugin-api'

const SIG = new Uint8Array(64).fill(0xaa)
const PUBKEY = new Uint8Array(32).fill(0xbb)

describe('encodeSignedOp / decodeSignedOp', () => {
  it('output length equals op.length + 96', () => {
    const op = new Uint8Array([1, 2, 3])
    expect(encodeSignedOp(op, SIG, PUBKEY).length).toBe(3 + 96)
  })

  it('round-trip preserves op, signature, and public key', () => {
    const op = new Uint8Array([1, 2, 3, 4, 5])
    const encoded = encodeSignedOp(op, SIG, PUBKEY)
    const { op: decodedOp, signature, signerPublicKey } = decodeSignedOp(encoded)
    expect(decodedOp).toEqual(op)
    expect(signature).toEqual(SIG)
    expect(signerPublicKey).toEqual(PUBKEY)
  })

  it('op bytes are at the start of the buffer', () => {
    const op = new Uint8Array([0x01, 0x02, 0x03])
    const encoded = encodeSignedOp(op, SIG, PUBKEY)
    expect(encoded.slice(0, 3)).toEqual(op)
  })

  it('signature occupies bytes [op.length, op.length+64)', () => {
    const op = new Uint8Array([0xff])
    const encoded = encodeSignedOp(op, SIG, PUBKEY)
    expect(encoded.slice(1, 65)).toEqual(SIG)
  })

  it('public key occupies the last 32 bytes', () => {
    const op = new Uint8Array([0xde, 0xad])
    const encoded = encodeSignedOp(op, SIG, PUBKEY)
    expect(encoded.slice(-32)).toEqual(PUBKEY)
  })

  it('works with an empty op (length 0)', () => {
    const encoded = encodeSignedOp(new Uint8Array(0), SIG, PUBKEY)
    expect(encoded.length).toBe(96)
    const { op, signature, signerPublicKey } = decodeSignedOp(encoded)
    expect(op.length).toBe(0)
    expect(signature).toEqual(SIG)
    expect(signerPublicKey).toEqual(PUBKEY)
  })

  it('works with a single-byte op', () => {
    const op = new Uint8Array([0x42])
    const decoded = decodeSignedOp(encodeSignedOp(op, SIG, PUBKEY))
    expect(decoded.op).toEqual(op)
  })

  it('different ops produce different encoded buffers', () => {
    const enc1 = encodeSignedOp(new Uint8Array([0x01]), SIG, PUBKEY)
    const enc2 = encodeSignedOp(new Uint8Array([0x02]), SIG, PUBKEY)
    expect(enc1).not.toEqual(enc2)
  })

  it('different signatures produce different encoded buffers', () => {
    const op = new Uint8Array([1])
    const sig2 = new Uint8Array(64).fill(0xcc)
    expect(encodeSignedOp(op, SIG, PUBKEY)).not.toEqual(encodeSignedOp(op, sig2, PUBKEY))
  })

  it('decodeSignedOp throws when input is shorter than 96 bytes', () => {
    expect(() => decodeSignedOp(new Uint8Array(95))).toThrow()
  })

  it('decodeSignedOp throws on empty input', () => {
    expect(() => decodeSignedOp(new Uint8Array(0))).toThrow()
  })

  it('decodeSignedOp succeeds on exactly 96 bytes (empty op)', () => {
    const buf = new Uint8Array(96)
    buf.set(SIG, 0)
    buf.set(PUBKEY, 64)
    const { op } = decodeSignedOp(buf)
    expect(op.length).toBe(0)
  })
})
