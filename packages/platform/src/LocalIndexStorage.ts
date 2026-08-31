// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import type { ILocalIndexStorage } from './ports'

export class InMemoryIndexStorage implements ILocalIndexStorage {
  private readonly store = new Map<string, { data: string; seq: number }>()

  async loadSnapshot(namespace: string): Promise<{ data: string; seq: number } | null> {
    return this.store.get(namespace) ?? null
  }

  async saveSnapshot(namespace: string, data: string, seq: number): Promise<void> {
    this.store.set(namespace, { data, seq })
  }
}

/**
 * LocalStorageIndexStorage — persists index snapshots in localStorage.
 * Survives page reloads. Scoped by vaultId to avoid cross-vault key collisions.
 * Key: `savoire:idx:{vaultId}:{namespace}`
 * see ADR-021
 */
export class LocalStorageIndexStorage implements ILocalIndexStorage {
  constructor(private readonly vaultId: string) {}

  private key(namespace: string): string {
    return `savoire:idx:${this.vaultId}:${namespace}`
  }

  async loadSnapshot(namespace: string): Promise<{ data: string; seq: number } | null> {
    try {
      const raw = localStorage.getItem(this.key(namespace))
      if (!raw) return null
      return JSON.parse(raw) as { data: string; seq: number }
    } catch {
      return null
    }
  }

  async saveSnapshot(namespace: string, data: string, seq: number): Promise<void> {
    try {
      localStorage.setItem(this.key(namespace), JSON.stringify({ data, seq }))
    } catch (err) {
      // localStorage quota exceeded — degrade silently, index stays in memory
      console.warn('[LocalStorageIndexStorage] saveSnapshot failed:', err)
    }
  }
}
