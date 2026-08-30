// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup

// Async variants: they derive SHA-512 via WebCrypto (subtle.digest), so the
// package's sync `hashes.sha512` hook does not need wiring. Both call sites
// here are already async.
import { signAsync, getPublicKeyAsync } from '@noble/ed25519'
import type { ISeedExportingIdentityProvider } from '@savoire/plugin-api'
import { fromHex } from '@savoire/plugin-api'

export interface ServerKeyProviderOptions {
  baseUrl?: string
  getToken: () => string | null
}

export class ServerKeyProvider implements ISeedExportingIdentityProvider {
  private privateKey: Uint8Array | null = null
  private publicKey: Uint8Array | null = null

  constructor(private readonly options: ServerKeyProviderOptions) {}

  private pending: Promise<void> | null = null

  async init(): Promise<void> {
    if (this.privateKey) return
    this.pending ??= this._fetchKey().catch((e) => { this.pending = null; throw e })
    await this.pending
  }

  private async _fetchKey(): Promise<void> {
    const token = this.options.getToken()
    if (!token) throw new Error('ServerKeyProvider: no auth token')
    const res = await fetch(`${this.options.baseUrl ?? ''}/api/v1/identity/key`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    if (!res.ok) throw new Error(`ServerKeyProvider: ${res.status}`)
    const { privateKey } = await res.json() as { privateKey: string }
    this.privateKey = fromHex(privateKey)
    this.publicKey = await getPublicKeyAsync(this.privateKey)
  }

  getPublicKey(): Uint8Array {
    if (!this.publicKey) throw new Error('ServerKeyProvider: not initialised, call init() first')
    return this.publicKey
  }

  async sign(message: Uint8Array): Promise<Uint8Array> {
    if (!this.privateKey) throw new Error('ServerKeyProvider: not initialised, call init() first')
    return signAsync(message, this.privateKey)
  }

  /**
   * Ed25519 seed for building the edgesync identity (OwnIdentity.fromSignSeed).
   * The key already transits through the identity API (accepted v0 debt); this
   * is the in-process bridge to the P2P protocol.
   */
  exportSignSeed(): Uint8Array {
    if (!this.privateKey) throw new Error('ServerKeyProvider: not initialised, call init() first')
    return this.privateKey
  }
}

