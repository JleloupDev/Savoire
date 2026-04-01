// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import type { ILocalIndexStorage } from './ports'

/**
 * InMemoryIndexStorage — implémentation POC de ILocalIndexStorage.
 * Les snapshots sont perdus au rechargement de la page.
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
