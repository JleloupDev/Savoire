// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup

// Async variants derive SHA-512 via WebCrypto; no sync hash hook to wire.
import { signAsync, getPublicKeyAsync } from '@noble/ed25519'
import type { ISeedExportingIdentityProvider } from '@savoire/plugin-api'
import { fromHex, toHex } from '@savoire/plugin-api'

const STORAGE_KEY = 'savoire:identity:privateKey'

export class LocalKeyProvider implements ISeedExportingIdentityProvider {
  private privateKey: Uint8Array | null = null
  private publicKeyCache: Uint8Array | null = null

  async init(): Promise<void> {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (stored) {
      this.privateKey = fromHex(stored)
    } else {
      this.privateKey = crypto.getRandomValues(new Uint8Array(32))
      localStorage.setItem(STORAGE_KEY, toHex(this.privateKey))
    }
    this.publicKeyCache = await getPublicKeyAsync(this.privateKey)
  }

  getPublicKey(): Uint8Array {
    if (!this.publicKeyCache) throw new Error('LocalKeyProvider: not initialised — call init() first')
    return this.publicKeyCache
  }

  async sign(message: Uint8Array): Promise<Uint8Array> {
    if (!this.privateKey) throw new Error('LocalKeyProvider: not initialised — call init() first')
    return signAsync(message, this.privateKey)
  }

  exportSignSeed(): Uint8Array {
    if (!this.privateKey) throw new Error('LocalKeyProvider: not initialised — call init() first')
    return this.privateKey
  }
}

