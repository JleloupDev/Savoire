// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
export function bytesToBase64(bytes: Uint8Array): string {
  if (typeof btoa !== 'function') throw new Error('btoa is not available in this runtime')
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary)
}

export function base64ToBytes(base64: string): Uint8Array {
  if (typeof atob !== 'function') throw new Error('atob is not available in this runtime')
  const binary = atob(base64)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
  return out
}
