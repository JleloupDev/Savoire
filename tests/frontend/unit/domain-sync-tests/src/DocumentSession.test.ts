// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import { describe, expect, it } from 'vitest'
import { ConnectivityState, DocumentSession, ReplicationMode, SyncState, UpdateSource } from '@savoire/domain-sync'
import type { DocumentUpdate } from '@savoire/domain-sync'

function mkUpdate(overrides?: Partial<DocumentUpdate>): DocumentUpdate {
  return {
    updateId: 'u1',
    documentId: 'd1',
    source: UpdateSource.Local,
    payload: new Uint8Array([1, 2, 3]),
    at: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  }
}

describe('DocumentSession', () => {
  it('initializes with defaults', () => {
    const s = new DocumentSession({ sessionId: 's1', documentId: 'd1', vaultId: 'v1' })
    expect(s.replicationMode).toBe(ReplicationMode.Bidirectional)
    expect(s.syncState).toBe(SyncState.NotInitialized)
    expect(s.connectivityState).toBe(ConnectivityState.Offline)
    expect(s.version).toBe(0)
    expect(s.pendingLocalUpdates).toEqual([])
    expect(s.appliedRemoteUpdateIds.size).toBe(0)
  })

  it('applyLocalUpdate pushes to pending, increments version and sets local pending state', () => {
    const s = new DocumentSession({ sessionId: 's1', documentId: 'd1', vaultId: 'v1' })
    const u = mkUpdate()
    s.applyLocalUpdate(u)
    expect(s.pendingLocalUpdates).toEqual([u])
    expect(s.version).toBe(1)
    expect(s.syncState).toBe(SyncState.LocalPending)
    expect(s.isDirty()).toBe(true)
  })

  it('rejects non-local update in applyLocalUpdate', () => {
    const s = new DocumentSession({ sessionId: 's1', documentId: 'd1', vaultId: 'v1' })
    expect(() => s.applyLocalUpdate(mkUpdate({ source: UpdateSource.Remote })))
      .toThrow('applyLocalUpdate expects a local update')
  })

  it('rejects update with mismatching document id in applyLocalUpdate', () => {
    const s = new DocumentSession({ sessionId: 's1', documentId: 'd1', vaultId: 'v1' })
    expect(() => s.applyLocalUpdate(mkUpdate({ documentId: 'other' })))
      .toThrow('Document id mismatch')
  })

  it('applyRemoteUpdate deduplicates by updateId', () => {
    const s = new DocumentSession({ sessionId: 's1', documentId: 'd1', vaultId: 'v1' })
    const u = mkUpdate({ source: UpdateSource.Remote, updateId: 'remote-1' })
    s.applyRemoteUpdate(u)
    s.applyRemoteUpdate(u)
    expect(s.version).toBe(1)
    expect(s.appliedRemoteUpdateIds.has('remote-1')).toBe(true)
  })

  it('applyRemoteUpdate sets in-sync when no pending locals', () => {
    const s = new DocumentSession({ sessionId: 's1', documentId: 'd1', vaultId: 'v1' })
    s.applyRemoteUpdate(mkUpdate({ source: UpdateSource.Remote, updateId: 'r1' }))
    expect(s.syncState).toBe(SyncState.InSync)
  })

  it('applyRemoteUpdate keeps local pending when pending locals exist', () => {
    const s = new DocumentSession({ sessionId: 's1', documentId: 'd1', vaultId: 'v1' })
    s.applyLocalUpdate(mkUpdate({ updateId: 'l1' }))
    s.applyRemoteUpdate(mkUpdate({ source: UpdateSource.Remote, updateId: 'r1' }))
    expect(s.syncState).toBe(SyncState.LocalPending)
  })

  it('rejects non-remote update in applyRemoteUpdate', () => {
    const s = new DocumentSession({ sessionId: 's1', documentId: 'd1', vaultId: 'v1' })
    expect(() => s.applyRemoteUpdate(mkUpdate({ source: UpdateSource.Local })))
      .toThrow('applyRemoteUpdate expects a remote update')
  })

  it('ackLocalUpdate removes update and flips to in-sync when queue becomes empty', () => {
    const s = new DocumentSession({ sessionId: 's1', documentId: 'd1', vaultId: 'v1' })
    s.applyLocalUpdate(mkUpdate({ updateId: 'l1' }))
    s.applyLocalUpdate(mkUpdate({ updateId: 'l2' }))
    s.ackLocalUpdate('l1')
    expect(s.pendingLocalUpdates.map(x => x.updateId)).toEqual(['l2'])
    expect(s.syncState).toBe(SyncState.LocalPending)
    s.ackLocalUpdate('l2')
    expect(s.pendingLocalUpdates).toEqual([])
    expect(s.syncState).toBe(SyncState.InSync)
    expect(s.isDirty()).toBe(false)
  })

  it('ackLocalUpdate is a no-op when unknown id', () => {
    const s = new DocumentSession({ sessionId: 's1', documentId: 'd1', vaultId: 'v1' })
    s.applyLocalUpdate(mkUpdate({ updateId: 'l1' }))
    s.ackLocalUpdate('missing')
    expect(s.pendingLocalUpdates).toHaveLength(1)
  })

  it('transitions connectivity states', () => {
    const s = new DocumentSession({ sessionId: 's1', documentId: 'd1', vaultId: 'v1' })
    s.markConnecting()
    expect(s.connectivityState).toBe(ConnectivityState.Connecting)
    s.markConnected()
    expect(s.connectivityState).toBe(ConnectivityState.Online)
    s.markDisconnected()
    expect(s.connectivityState).toBe(ConnectivityState.Offline)
  })

  it('transitions to conflict and error states', () => {
    const s = new DocumentSession({ sessionId: 's1', documentId: 'd1', vaultId: 'v1' })
    s.markConflict()
    expect(s.syncState).toBe(SyncState.Conflict)
    s.markError()
    expect(s.syncState).toBe(SyncState.Error)
  })

  // ── Coverage additions ────────────────────────────────────────────────────

  it('initializes with all explicit constructor params', () => {
    const pending = mkUpdate({ updateId: 'l1' })
    const s = new DocumentSession({
      sessionId: 's99',
      documentId: 'd1',
      vaultId: 'v1',
      replicationMode: ReplicationMode.LocalOnly,
      syncState: SyncState.InSync,
      connectivityState: ConnectivityState.Online,
      version: 7,
      pendingLocalUpdates: [pending],
      appliedRemoteUpdateIds: ['r1', 'r2'],
    })
    expect(s.sessionId).toBe('s99')
    expect(s.replicationMode).toBe(ReplicationMode.LocalOnly)
    expect(s.syncState).toBe(SyncState.InSync)
    expect(s.connectivityState).toBe(ConnectivityState.Online)
    expect(s.version).toBe(7)
    expect(s.pendingLocalUpdates).toEqual([pending])
    expect(s.appliedRemoteUpdateIds.has('r1')).toBe(true)
    expect(s.appliedRemoteUpdateIds.has('r2')).toBe(true)
    expect(s.isDirty()).toBe(true)
  })

  it('rejects update with mismatching document id in applyRemoteUpdate', () => {
    const s = new DocumentSession({ sessionId: 's1', documentId: 'd1', vaultId: 'v1' })
    expect(() =>
      s.applyRemoteUpdate(mkUpdate({ source: UpdateSource.Remote, documentId: 'other-doc' })),
    ).toThrow('Document id mismatch')
  })

  it('isDirty returns false on fresh session', () => {
    const s = new DocumentSession({ sessionId: 's1', documentId: 'd1', vaultId: 'v1' })
    expect(s.isDirty()).toBe(false)
  })

  it('exposes vaultId and documentId', () => {
    const s = new DocumentSession({ sessionId: 's1', documentId: 'doc-42', vaultId: 'vault-99' })
    expect(s.documentId).toBe('doc-42')
    expect(s.vaultId).toBe('vault-99')
  })

  it('multiple local updates accumulate version and pending queue', () => {
    const s = new DocumentSession({ sessionId: 's1', documentId: 'd1', vaultId: 'v1' })
    s.applyLocalUpdate(mkUpdate({ updateId: 'a' }))
    s.applyLocalUpdate(mkUpdate({ updateId: 'b' }))
    s.applyLocalUpdate(mkUpdate({ updateId: 'c' }))
    expect(s.version).toBe(3)
    expect(s.pendingLocalUpdates).toHaveLength(3)
    expect(s.isDirty()).toBe(true)
  })

  it('initializes with RemoteOnly replication mode', () => {
    const s = new DocumentSession({
      sessionId: 's1',
      documentId: 'd1',
      vaultId: 'v1',
      replicationMode: ReplicationMode.RemoteOnly,
    })
    expect(s.replicationMode).toBe(ReplicationMode.RemoteOnly)
  })
})
