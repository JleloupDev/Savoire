// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import { SyncState } from './enums'

export class VaultSyncState {
  constructor(
    public syncState: SyncState = SyncState.NotInitialized,
    public lastSyncedAt: Date | null = null,
    public syncError: string | null = null,
  ) {}

  markInSync(at: Date): void {
    this.syncState = SyncState.InSync
    this.lastSyncedAt = at
    this.syncError = null
  }

  markSyncing(): void {
    this.syncState = SyncState.LocalPending
    this.syncError = null
  }

  markOutOfSync(reason: string): void {
    this.syncState = SyncState.LocalPending
    this.syncError = reason
  }

  markConflict(reason: string): void {
    this.syncState = SyncState.Conflict
    this.syncError = reason
  }

  markError(reason: string): void {
    this.syncState = SyncState.Error
    this.syncError = reason
  }
}
