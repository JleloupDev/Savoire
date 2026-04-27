// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import type { ILocalIndexStorage } from './ports'

interface IndexSnapshotDto {
  namespace: string
  processedSeq: number
  data: string
  createdAt: string
}

/**
 * ServerIndexStorage — persists index snapshots server-side via REST.
 * TEMPORARY — will be replaced by a Node.js sidecar connected as a regular CRDT client.
 * Route: /api/v1/vaults/{vaultId}/index-snapshots/{namespace}
 * see ADR-022
 */
export class ServerIndexStorage implements ILocalIndexStorage {
  constructor(
    private readonly vaultId: string,
    private readonly getToken: () => string | null | undefined,
    private readonly baseUrl: string = '',
  ) {}

  async loadSnapshot(namespace: string): Promise<{ data: string; seq: number } | null> {
    try {
      const token = this.getToken()
      const res = await fetch(
        `${this.baseUrl}/api/v1/vaults/${encodeURIComponent(this.vaultId)}/index-snapshots/${encodeURIComponent(namespace)}`,
        { headers: token ? { Authorization: `Bearer ${token}` } : {} },
      )
      if (res.status === 404) return null
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const dto = await res.json() as IndexSnapshotDto
      return { data: dto.data, seq: dto.processedSeq }
    } catch (err) {
      console.warn('[ServerIndexStorage] loadSnapshot failed:', err)
      return null
    }
  }

  async saveSnapshot(namespace: string, data: string, seq: number): Promise<void> {
    try {
      const token = this.getToken()
      const res = await fetch(
        `${this.baseUrl}/api/v1/vaults/${encodeURIComponent(this.vaultId)}/index-snapshots/${encodeURIComponent(namespace)}`,
        {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify({ namespace, processedSeq: seq, data }),
        },
      )
      if (!res.ok && res.status !== 204) {
        console.warn(`[ServerIndexStorage] saveSnapshot HTTP ${res.status}`)
      }
    } catch (err) {
      console.warn('[ServerIndexStorage] saveSnapshot failed:', err)
    }
  }
}

/**
 * InMemoryIndexStorage — POC implementation of ILocalIndexStorage.
 * Snapshots are lost on page reload.
 * see ADR-021
 */
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
