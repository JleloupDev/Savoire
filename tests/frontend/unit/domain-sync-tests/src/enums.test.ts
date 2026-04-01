// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import { describe, expect, it } from 'vitest'
import { ConnectivityState, ReplicationMode, SyncState, UpdateSource } from '@savoire/domain-sync'

describe('enums', () => {
  it('ReplicationMode values', () => {
    expect(ReplicationMode.LocalOnly).toBe('local_only')
    expect(ReplicationMode.RemoteOnly).toBe('remote_only')
    expect(ReplicationMode.Bidirectional).toBe('bidirectional')
  })

  it('ConnectivityState values', () => {
    expect(ConnectivityState.Offline).toBe('offline')
    expect(ConnectivityState.Connecting).toBe('connecting')
    expect(ConnectivityState.Online).toBe('online')
  })

  it('SyncState values', () => {
    expect(SyncState.NotInitialized).toBe('not_initialized')
    expect(SyncState.InSync).toBe('in_sync')
    expect(SyncState.LocalPending).toBe('local_pending')
    expect(SyncState.Conflict).toBe('conflict')
    expect(SyncState.Error).toBe('error')
  })

  it('UpdateSource values', () => {
    expect(UpdateSource.Local).toBe('local')
    expect(UpdateSource.Remote).toBe('remote')
  })
})
