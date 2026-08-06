// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// S3 implementation of EdgesyncVaultSession's KeyringSource: the server holds
// a per-user, per-vault copy of the Keyring wrapped under that account's own
// K_User (VaultKeyWrapController) — a blind escrow, never usable server-side.
// K_User itself never appears in any request this class makes.
import { Keyring, encrypt, decrypt, concat } from 'edgesync-protocol'
import { bytesToBase64, base64ToBytes } from './base64'
import type { KeyringSource } from './EdgesyncVaultSession'

const NONCE_BYTES = 24

/** Thrown when the server has a wrapped Keyring for this (user, vault) but
 *  the current K_User does not decrypt it — distinct from "nothing stored
 *  yet" (fetch() resolves to undefined for that case instead). Callers must
 *  not treat this the same as "fresh vault": see EdgesyncVaultSession.restore(). */
export class WrongVaultKeyError extends Error {
  constructor(vaultId: string) {
    super(`Vault key does not decrypt the stored Keyring for vault ${vaultId}`)
    this.name = 'WrongVaultKeyError'
  }
}

export interface VaultKeyEscrowOptions {
  baseUrl?: string
  getToken: () => string | null
  /** K_User for the current session, or null if not entered yet — read at
   *  call time, not captured once, so the same instance keeps working across
   *  a lock/unlock cycle within one page session. */
  getVaultKey: () => Uint8Array | null
}

export class VaultKeyEscrow implements KeyringSource {
  constructor(private readonly options: VaultKeyEscrowOptions) {}

  async fetch(vaultId: string): Promise<Keyring | undefined> {
    const res = await fetch(this.url(vaultId), { headers: this.headers() })
    if (res.status === 404) return undefined
    if (!res.ok) throw new Error(`VaultKeyEscrow: GET ${res.status}`)
    const { bytesBase64 } = await res.json() as { bytesBase64: string }
    const wrapped = base64ToBytes(bytesBase64)
    // A blob exists server-side — check the server unconditionally (above)
    // even with no local key, so callers can tell "locked" (blob exists, no
    // usable key) apart from "nothing escrowed yet" (404). Only the decrypt
    // attempt itself is skipped without a key.
    const userKey = this.options.getVaultKey()
    if (!userKey) throw new WrongVaultKeyError(vaultId)
    try {
      const keyringBytes = decrypt(userKey, wrapped.subarray(0, NONCE_BYTES), wrapped.subarray(NONCE_BYTES))
      return Keyring.deserialize(keyringBytes)
    } catch {
      throw new WrongVaultKeyError(vaultId)
    }
  }

  async save(vaultId: string, keyring: Keyring): Promise<void> {
    const userKey = this.options.getVaultKey()
    if (!userKey) return // nothing to wrap under — caller proceeds without escrow this session
    const { nonce, ciphertext } = encrypt(userKey, keyring.serialize())
    const res = await fetch(this.url(vaultId), {
      method: 'PUT',
      headers: { ...this.headers(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ bytesBase64: bytesToBase64(concat(nonce, ciphertext)) }),
    })
    if (!res.ok) throw new Error(`VaultKeyEscrow: PUT ${res.status}`)
  }

  private url(vaultId: string): string {
    return `${this.options.baseUrl ?? ''}/api/v1/vaults/${encodeURIComponent(vaultId)}/key-wrap`
  }

  private headers(): HeadersInit {
    const token = this.options.getToken()
    return token ? { Authorization: `Bearer ${token}` } : {}
  }
}
