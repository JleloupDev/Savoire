// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import { describe, expect, it } from 'vitest'
import { SyncState, VaultSyncState } from '@savoire/domain-sync'

describe('VaultSyncState', () => {
  it('starts not initialized by default', () => {
    const s = new VaultSyncState()
    expect(s.syncState).toBe(SyncState.NotInitialized)
    expect(s.lastSyncedAt).toBeNull()
    expect(s.syncError).toBeNull()
  })

  it('marks in sync and clears errors', () => {
    const s = new VaultSyncState(SyncState.Error, null, 'boom')
    const t = new Date('2026-01-01T00:00:00.000Z')
    s.markInSync(t)
    expect(s.syncState).toBe(SyncState.InSync)
    expect(s.lastSyncedAt).toEqual(t)
    expect(s.syncError).toBeNull()
  })

  it('marks syncing', () => {
    const s = new VaultSyncState()
    s.markSyncing()
    expect(s.syncState).toBe(SyncState.LocalPending)
    expect(s.syncError).toBeNull()
  })

  it('marks out of sync with reason', () => {
    const s = new VaultSyncState()
    s.markOutOfSync('network')
    expect(s.syncState).toBe(SyncState.LocalPending)
    expect(s.syncError).toBe('network')
  })

  it('marks conflict', () => {
    const s = new VaultSyncState()
    s.markConflict('conflict')
    expect(s.syncState).toBe(SyncState.Conflict)
    expect(s.syncError).toBe('conflict')
  })

  it('marks error', () => {
    const s = new VaultSyncState()
    s.markError('error')
    expect(s.syncState).toBe(SyncState.Error)
    expect(s.syncError).toBe('error')
  })

  // ── Coverage additions ────────────────────────────────────────────────────

  it('accepts explicit constructor arguments', () => {
    const t = new Date('2026-03-01T00:00:00.000Z')
    const s = new VaultSyncState(SyncState.InSync, t, null)
    expect(s.syncState).toBe(SyncState.InSync)
    expect(s.lastSyncedAt).toEqual(t)
    expect(s.syncError).toBeNull()
  })

  it('markSyncing clears prior error', () => {
    const s = new VaultSyncState(SyncState.Error, null, 'previous error')
    s.markSyncing()
    expect(s.syncError).toBeNull()
  })

  it('markInSync updates lastSyncedAt each time', () => {
    const s = new VaultSyncState()
    const t1 = new Date('2026-01-01T00:00:00.000Z')
    const t2 = new Date('2026-06-01T00:00:00.000Z')
    s.markInSync(t1)
    expect(s.lastSyncedAt).toEqual(t1)
    s.markInSync(t2)
    expect(s.lastSyncedAt).toEqual(t2)
  })

  it('can transition from Conflict back to InSync', () => {
    const s = new VaultSyncState()
    s.markConflict('c')
    expect(s.syncState).toBe(SyncState.Conflict)
    s.markInSync(new Date())
    expect(s.syncState).toBe(SyncState.InSync)
    expect(s.syncError).toBeNull()
  })
})
