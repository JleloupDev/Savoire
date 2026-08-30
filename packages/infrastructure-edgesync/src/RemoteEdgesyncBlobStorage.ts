// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// IStorage backed by the server's blind, per-vault blob store (EdgesyncBlobController).
// Restricted to `open/…` keys: `secret/…` values (identity, keyring) must never
// leave the device — see ports/storage.ts's namespace convention. This is a
// best-effort backup/HA layer for peers already admitted to the vault, never a
// substitute for the normal K_vault grant flow. Persists CONTENT only — the
// Keyring itself is recovered through a separate mechanism, see VaultKeyEscrow.ts.
import type { IStorage } from 'edgesync-protocol'
import { bytesToBase64, base64ToBytes } from '@savoire/infrastructure-sync'

export interface RemoteEdgesyncBlobStorageOptions {
  vaultId: string
  baseUrl?: string
  getToken: () => string | null
}

function isSecret(key: string): boolean {
  return key.startsWith('secret/')
}

export class RemoteEdgesyncBlobStorage implements IStorage {
  constructor(private readonly options: RemoteEdgesyncBlobStorageOptions) {}

  async get(key: string): Promise<Uint8Array | undefined> {
    if (isSecret(key)) return undefined
    const res = await fetch(this.url(key), { headers: this.headers() })
    if (res.status === 404) return undefined
    if (!res.ok) throw new Error(`RemoteEdgesyncBlobStorage: GET ${res.status}`)
    const { bytesBase64 } = await res.json() as { bytesBase64: string }
    return base64ToBytes(bytesBase64)
  }

  async set(key: string, value: Uint8Array): Promise<void> {
    if (isSecret(key)) return
    const res = await fetch(this.url(key), {
      method: 'PUT',
      headers: { ...this.headers(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ bytesBase64: bytesToBase64(value) }),
    })
    if (!res.ok) throw new Error(`RemoteEdgesyncBlobStorage: PUT ${res.status}`)
  }

  async delete(): Promise<void> {
    // No delete endpoint (yet): an edgesync blob is only ever overwritten with
    // fresher content, never explicitly removed — see persistence.ts's saveAll.
  }

  private url(key: string): string {
    return `${this.options.baseUrl ?? ''}/api/v1/vaults/${encodeURIComponent(this.options.vaultId)}/edgesync-blobs/${key}`
  }

  private headers(): HeadersInit {
    const token = this.options.getToken()
    return token ? { Authorization: `Bearer ${token}` } : {}
  }
}
