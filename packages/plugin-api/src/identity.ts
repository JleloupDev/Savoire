// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup

export interface IIdentityProvider {
  init(): Promise<void>
  getPublicKey(): Uint8Array
  sign(message: Uint8Array): Promise<Uint8Array>
}

// ── SignedOp binary envelope ──────────────────────────────────────────────────
// Layout: [ op bytes ][ signature: 64 bytes ][ pubKey: 32 bytes ]
// Ed25519 signature and public key have fixed sizes, so no length prefix needed.

const SIG_BYTES = 64
const PUBKEY_BYTES = 32
const OVERHEAD = SIG_BYTES + PUBKEY_BYTES

export function encodeSignedOp(op: Uint8Array, signature: Uint8Array, signerPublicKey: Uint8Array): Uint8Array {
  const out = new Uint8Array(op.length + OVERHEAD)
  out.set(op, 0)
  out.set(signature, op.length)
  out.set(signerPublicKey, op.length + SIG_BYTES)
  return out
}

export function decodeSignedOp(bytes: Uint8Array): { op: Uint8Array; signature: Uint8Array; signerPublicKey: Uint8Array } {
  if (bytes.length < OVERHEAD) throw new Error('SignedOp too short')
  const op = bytes.slice(0, bytes.length - OVERHEAD)
  const signature = bytes.slice(bytes.length - OVERHEAD, bytes.length - PUBKEY_BYTES)
  const signerPublicKey = bytes.slice(bytes.length - PUBKEY_BYTES)
  return { op, signature, signerPublicKey }
}

// ── Shared hex utilities ──────────────────────────────────────────────────────

export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')
}

export function fromHex(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error('Invalid hex string')
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return out
}
