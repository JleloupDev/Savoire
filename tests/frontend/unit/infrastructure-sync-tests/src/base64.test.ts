// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import { describe, it, expect } from 'vitest'
import { bytesToBase64, base64ToBytes } from '../../../../../packages/infrastructure-sync/src/base64'

describe('bytesToBase64', () => {
  it('encodes empty bytes to empty string', () => {
    expect(bytesToBase64(new Uint8Array([]))).toBe('')
  })

  it('encodes single byte', () => {
    // 0x00 → 'AA=='
    expect(bytesToBase64(new Uint8Array([0]))).toBe('AA==')
  })

  it('encodes known bytes (ASCII "Hello")', () => {
    // [72, 101, 108, 108, 111] = "Hello"
    expect(bytesToBase64(new Uint8Array([72, 101, 108, 108, 111]))).toBe('SGVsbG8=')
  })

  it('roundtrip: encode then decode returns original bytes (ASCII range)', () => {
    // Use bytes 0-127 to stay within safe ASCII range for Node.js btoa
    const original = new Uint8Array([0, 1, 2, 63, 64, 126, 127])
    const encoded = bytesToBase64(original)
    const decoded = base64ToBytes(encoded)
    expect(decoded).toEqual(original)
  })

  it('handles bytes 0-127 (safe ASCII range)', () => {
    const bytes = new Uint8Array(128)
    for (let i = 0; i < 128; i++) bytes[i] = i
    const encoded = bytesToBase64(bytes)
    const decoded = base64ToBytes(encoded)
    expect(decoded).toEqual(bytes)
  })
})

describe('base64ToBytes', () => {
  it('decodes empty string to empty bytes', () => {
    expect(base64ToBytes('')).toEqual(new Uint8Array([]))
  })

  it('decodes known base64 string', () => {
    expect(base64ToBytes('SGVsbG8=')).toEqual(new Uint8Array([72, 101, 108, 108, 111]))
  })

  it('decodes AA== to single zero byte', () => {
    expect(base64ToBytes('AA==')).toEqual(new Uint8Array([0]))
  })

  it('roundtrip: decode then encode returns original string', () => {
    const b64 = 'SGVsbG8gV29ybGQ='
    const bytes = base64ToBytes(b64)
    expect(bytesToBase64(bytes)).toBe(b64)
  })
})
