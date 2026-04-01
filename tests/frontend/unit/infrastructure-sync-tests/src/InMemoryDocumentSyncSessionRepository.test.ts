// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import { describe, it, expect } from 'vitest'
import { InMemoryDocumentSyncSessionRepository } from '@savoire/infrastructure-sync'
import { DocumentSession } from '@savoire/domain-sync'

function makeSession(vaultId: string, documentId: string): DocumentSession {
  return new DocumentSession({ sessionId: `${vaultId}:${documentId}`, documentId, vaultId })
}

describe('InMemoryDocumentSyncSessionRepository', () => {
  it('get returns undefined for unknown session', async () => {
    const repo = new InMemoryDocumentSyncSessionRepository()
    expect(await repo.get('v1', 'd1')).toBeUndefined()
  })

  it('save stores a session', async () => {
    const repo = new InMemoryDocumentSyncSessionRepository()
    const session = makeSession('v1', 'd1')
    await repo.save(session)
    expect(await repo.get('v1', 'd1')).toBe(session)
  })

  it('get returns the same session instance that was saved', async () => {
    const repo = new InMemoryDocumentSyncSessionRepository()
    const session = makeSession('vault-a', 'doc-b')
    await repo.save(session)
    const retrieved = await repo.get('vault-a', 'doc-b')
    expect(retrieved).toBe(session)
  })

  it('remove deletes a stored session', async () => {
    const repo = new InMemoryDocumentSyncSessionRepository()
    const session = makeSession('v1', 'd1')
    await repo.save(session)
    await repo.remove('v1', 'd1')
    expect(await repo.get('v1', 'd1')).toBeUndefined()
  })

  it('remove on non-existent key is a no-op', async () => {
    const repo = new InMemoryDocumentSyncSessionRepository()
    await expect(repo.remove('v1', 'd1')).resolves.toBeUndefined()
  })

  it('sessions with the same documentId but different vaultId are independent', async () => {
    const repo = new InMemoryDocumentSyncSessionRepository()
    const s1 = makeSession('vault-A', 'doc-1')
    const s2 = makeSession('vault-B', 'doc-1')
    await repo.save(s1)
    await repo.save(s2)
    expect(await repo.get('vault-A', 'doc-1')).toBe(s1)
    expect(await repo.get('vault-B', 'doc-1')).toBe(s2)
  })

  it('sessions with the same vaultId but different documentId are independent', async () => {
    const repo = new InMemoryDocumentSyncSessionRepository()
    const s1 = makeSession('v1', 'doc-A')
    const s2 = makeSession('v1', 'doc-B')
    await repo.save(s1)
    await repo.save(s2)
    expect(await repo.get('v1', 'doc-A')).toBe(s1)
    expect(await repo.get('v1', 'doc-B')).toBe(s2)
  })

  it('save overwrites existing session with same key', async () => {
    const repo = new InMemoryDocumentSyncSessionRepository()
    const s1 = makeSession('v1', 'd1')
    const s2 = makeSession('v1', 'd1')
    await repo.save(s1)
    await repo.save(s2)
    expect(await repo.get('v1', 'd1')).toBe(s2)
  })

  it('can store many independent sessions', async () => {
    const repo = new InMemoryDocumentSyncSessionRepository()
    const sessions = Array.from({ length: 10 }, (_, i) => makeSession('v1', `doc-${i}`))
    await Promise.all(sessions.map(s => repo.save(s)))
    for (let i = 0; i < 10; i++) {
      expect(await repo.get('v1', `doc-${i}`)).toBe(sessions[i])
    }
  })
})
