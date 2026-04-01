// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import { describe, expect, it } from 'vitest'
import { ConnectivityState, Document, ReplicationMode, SyncState, Vault, VaultSyncState } from '@savoire/domain-sync'

describe('Vault', () => {
  it('initializes with defaults', () => {
    const v = new Vault({ id: 'v1', name: 'Main' })
    expect(v.replicationMode).toBe(ReplicationMode.Bidirectional)
    expect(v.connectivityState).toBe(ConnectivityState.Offline)
    expect(v.sync.syncState).toBe(SyncState.NotInitialized)
  })

  it('adds and gets documents', () => {
    const v = new Vault({ id: 'v1', name: 'Main' })
    const d = new Document({ id: 'd1', name: 'a.md', path: 'a.md' })
    v.addDocument(d)
    expect(v.getDocument('d1')).toBe(d)
  })

  it('replaces document when same id is added', () => {
    const v = new Vault({ id: 'v1', name: 'Main' })
    v.addDocument(new Document({ id: 'd1', name: 'a.md', path: 'a.md' }))
    const next = new Document({ id: 'd1', name: 'b.md', path: 'b.md' })
    v.addDocument(next)
    expect(v.getDocument('d1')).toBe(next)
    expect(v.listDocuments()).toHaveLength(1)
  })

  it('removes documents', () => {
    const v = new Vault({ id: 'v1', name: 'Main' })
    v.addDocument(new Document({ id: 'd1', name: 'a.md', path: 'a.md' }))
    v.removeDocument('d1')
    expect(v.getDocument('d1')).toBeUndefined()
  })

  it('lists document metas sorted by path', () => {
    const v = new Vault({ id: 'v1', name: 'Main' })
    v.addDocument(new Document({ id: 'd2', name: 'z.md', path: 'z.md' }))
    v.addDocument(new Document({ id: 'd1', name: 'a.md', path: 'a.md' }))
    expect(v.listDocuments().map(x => x.path)).toEqual(['a.md', 'z.md'])
  })

  it('renames the vault', () => {
    const v = new Vault({ id: 'v1', name: 'Main' })
    v.rename('Renamed')
    expect(v.name).toBe('Renamed')
  })

  it('rejects blank vault name on creation', () => {
    expect(() => new Vault({ id: 'v1', name: '   ' })).toThrow('name must not be empty')
  })

  it('rejects blank vault name on rename', () => {
    const v = new Vault({ id: 'v1', name: 'Main' })
    expect(() => v.rename('   ')).toThrow('newName must not be empty')
  })

  it('transitions connectivity states', () => {
    const v = new Vault({ id: 'v1', name: 'Main' })
    v.markConnecting()
    expect(v.connectivityState).toBe(ConnectivityState.Connecting)
    v.markOnline()
    expect(v.connectivityState).toBe(ConnectivityState.Online)
    v.markOffline()
    expect(v.connectivityState).toBe(ConnectivityState.Offline)
  })

  it('delegates sync transitions to VaultSyncState', () => {
    const sync = new VaultSyncState()
    const v = new Vault({ id: 'v1', name: 'Main', sync })
    v.markSyncing()
    expect(sync.syncState).toBe(SyncState.LocalPending)
    v.markOutOfSync('lag')
    expect(sync.syncError).toBe('lag')
    v.markConflict('conflict')
    expect(sync.syncState).toBe(SyncState.Conflict)
    v.markError('boom')
    expect(sync.syncState).toBe(SyncState.Error)
  })

  // ── Coverage additions ────────────────────────────────────────────────────

  it('initializes with pre-populated documents from constructor', () => {
    const d1 = new Document({ id: 'd1', name: 'a.md', path: 'a.md' })
    const d2 = new Document({ id: 'd2', name: 'b.md', path: 'b.md' })
    const v = new Vault({ id: 'v1', name: 'Main', documents: [d1, d2] })
    expect(v.getDocument('d1')).toBe(d1)
    expect(v.getDocument('d2')).toBe(d2)
    expect(v.listDocuments()).toHaveLength(2)
  })

  it('initializes with explicit replicationMode and connectivityState', () => {
    const v = new Vault({
      id: 'v1',
      name: 'Main',
      replicationMode: ReplicationMode.LocalOnly,
      connectivityState: ConnectivityState.Online,
    })
    expect(v.replicationMode).toBe(ReplicationMode.LocalOnly)
    expect(v.connectivityState).toBe(ConnectivityState.Online)
  })

  it('delegates markInSync to VaultSyncState', () => {
    const sync = new VaultSyncState()
    const v = new Vault({ id: 'v1', name: 'Main', sync })
    const t = new Date('2026-01-01T00:00:00.000Z')
    v.markInSync(t)
    expect(sync.syncState).toBe(SyncState.InSync)
    expect(sync.lastSyncedAt).toEqual(t)
    expect(sync.syncError).toBeNull()
  })

  it('listDocuments returns empty array when no documents', () => {
    const v = new Vault({ id: 'v1', name: 'Main' })
    expect(v.listDocuments()).toEqual([])
  })

  it('getDocument returns undefined for unknown id', () => {
    const v = new Vault({ id: 'v1', name: 'Main' })
    expect(v.getDocument('nope')).toBeUndefined()
  })

  it('removeDocument on non-existent id is a no-op', () => {
    const v = new Vault({ id: 'v1', name: 'Main' })
    expect(() => v.removeDocument('nope')).not.toThrow()
  })

  it('exposes id correctly', () => {
    const v = new Vault({ id: 'vault-99', name: 'Main' })
    expect(v.id).toBe('vault-99')
  })
})
