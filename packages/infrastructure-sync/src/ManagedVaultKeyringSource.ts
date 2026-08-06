// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// S2 for a vault (as opposed to S3/VaultKeyEscrow, per-account via K_User):
// the server holds the Keyring in clear, server-side, for THIS vault — never
// wrapped, no K_User involved. Decided once at vault creation (Vault.IsManaged
// on the backend), never converted afterwards here. Same principle as
// GetIdentityKeyQuery/PrivateKeyHex (S2 already accepted in this project),
// applied to the vault's Keyring instead of the identity key.
import { Keyring } from 'edgesync-protocol'
import { bytesToBase64, base64ToBytes } from './base64'
import type { KeyringSource } from './EdgesyncVaultSession'

export interface ManagedVaultKeyringSourceOptions {
  baseUrl?: string
  getToken: () => string | null
}

export class ManagedVaultKeyringSource implements KeyringSource {
  constructor(private readonly options: ManagedVaultKeyringSourceOptions) {}

  async fetch(vaultId: string): Promise<Keyring | undefined> {
    const res = await fetch(this.url(vaultId), { headers: this.headers() })
    if (res.status === 404) return undefined
    if (!res.ok) throw new Error(`ManagedVaultKeyringSource: GET ${res.status}`)
    const { bytesBase64 } = await res.json() as { bytesBase64: string }
    return Keyring.deserialize(base64ToBytes(bytesBase64))
  }

  async save(vaultId: string, keyring: Keyring): Promise<void> {
    const res = await fetch(this.url(vaultId), {
      method: 'PUT',
      headers: { ...this.headers(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ bytesBase64: bytesToBase64(keyring.serialize()) }),
    })
    if (!res.ok) throw new Error(`ManagedVaultKeyringSource: PUT ${res.status}`)
  }

  private url(vaultId: string): string {
    return `${this.options.baseUrl ?? ''}/api/v1/vaults/${encodeURIComponent(vaultId)}/managed-keyring`
  }

  private headers(): HeadersInit {
    const token = this.options.getToken()
    return token ? { Authorization: `Bearer ${token}` } : {}
  }
}
