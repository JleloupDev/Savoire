// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// S2 option for K_User: the server generates and holds a copy in clear,
// served back over an authenticated endpoint — mirrors ServerKeyProvider.ts's
// identity-key pattern exactly, but for K_User instead of the signing key.
// Deliberately separate from ServerKeyProvider (K_User stays unrelated to
// identity, see VaultKeyEscrow.ts). Callers must only invoke fetchOrCreate()
// after an explicit user choice (or for an account that already made that
// choice) — the server lazily generates on ANY call, so calling this blindly
// for every account would silently opt them all into S2.
import { fromHex } from '@savoire/plugin-api'

export interface ServerVaultKeyProviderOptions {
  baseUrl?: string
  getToken: () => string | null
}

export class ServerVaultKeyProvider {
  private pending: Promise<Uint8Array> | null = null

  constructor(private readonly options: ServerVaultKeyProviderOptions) {}

  /** Dedupes callers that overlap in time (e.g. AppShell's silent auto-fetch
   *  on load racing a click that also needs the key) onto a single in-flight
   *  request — not a permanent cache: once it settles, `pending` clears, so
   *  the next (non-overlapping) call still fetches fresh, same as before. */
  fetchOrCreate(): Promise<Uint8Array> {
    this.pending ??= this._fetch().finally(() => { this.pending = null })
    return this.pending
  }

  private async _fetch(): Promise<Uint8Array> {
    const token = this.options.getToken()
    if (!token) throw new Error('ServerVaultKeyProvider: no auth token')
    const res = await fetch(`${this.options.baseUrl ?? ''}/api/v1/vault-key`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    if (!res.ok) throw new Error(`ServerVaultKeyProvider: ${res.status}`)
    const { vaultKey } = await res.json() as { vaultKey: string }
    return fromHex(vaultKey)
  }
}
