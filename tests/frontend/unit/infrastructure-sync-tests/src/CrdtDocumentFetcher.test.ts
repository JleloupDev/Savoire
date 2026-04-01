// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import { describe, it, expect, vi } from 'vitest'
import * as Y from 'yjs'
import { HubConnectionState } from '@microsoft/signalr'
import { CrdtDocumentFetcher } from '@savoire/infrastructure-sync'
import { bytesToBase64 } from '@savoire/infrastructure-sync'

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeYjsOp(text: string): string {
  const doc = new Y.Doc()
  doc.getText('codemirror').insert(0, text)
  return bytesToBase64(Y.encodeStateAsUpdate(doc))
}

type EventHandler = (...args: unknown[]) => void

interface MockConnection {
  state: HubConnectionState
  start: ReturnType<typeof vi.fn>
  on: ReturnType<typeof vi.fn>
  invoke: ReturnType<typeof vi.fn>
  _emit: (event: string, ...args: unknown[]) => void
}

function makeMockConnection(opsPerDoc: Record<string, string[]>): MockConnection {
  const handlers = new Map<string, EventHandler>()

  const conn: MockConnection = {
    state: HubConnectionState.Connected,
    start: vi.fn(async () => {}),
    on: vi.fn((event: string, handler: EventHandler) => {
      handlers.set(event, handler)
    }),
    invoke: vi.fn(async (method: string, _vaultId: string, docId: string) => {
      if (method === 'JoinDocument') {
        const ops = opsPerDoc[docId] ?? []
        handlers.get('InitDocument')?.(docId, ops)
      }
    }),
    _emit: (event: string, ...args: unknown[]) => {
      handlers.get(event)?.(...args)
    },
  }
  return conn
}

function makeFetcher(opsPerDoc: Record<string, string[]>) {
  const conn = makeMockConnection(opsPerDoc)
  const fetcher = new CrdtDocumentFetcher({
    connectionFactory: () => conn as never,
  })
  return { fetcher, conn }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('CrdtDocumentFetcher.getDocumentContent()', () => {
  it('reconstructs text from InitDocument ops', async () => {
    const { fetcher } = makeFetcher({ 'doc-1': [makeYjsOp('# Hello')] })
    const text = await fetcher.getDocumentContent('vault-1', 'doc-1', 'tok')
    expect(text).toBe('# Hello')
  })

  it('returns empty string when ops array is empty', async () => {
    const { fetcher } = makeFetcher({ 'doc-1': [] })
    const text = await fetcher.getDocumentContent('vault-1', 'doc-1', 'tok')
    expect(text).toBe('')
  })

  it('does not call JoinDocument again on cache hit', async () => {
    const { fetcher, conn } = makeFetcher({ 'doc-1': [makeYjsOp('Hello')] })
    await fetcher.getDocumentContent('vault-1', 'doc-1', 'tok')
    await fetcher.getDocumentContent('vault-1', 'doc-1', 'tok')
    expect(conn.invoke).toHaveBeenCalledTimes(1)
  })

  it('returns latest text from cache after ReceiveOperation', async () => {
    // Build the initial op and reuse the same doc to produce a correct incremental update
    const sharedDoc = new Y.Doc()
    sharedDoc.getText('codemirror').insert(0, 'Hello')
    const helloOp = bytesToBase64(Y.encodeStateAsUpdate(sharedDoc))

    const { fetcher, conn } = makeFetcher({ 'doc-1': [helloOp] })
    await fetcher.getDocumentContent('vault-1', 'doc-1', 'tok')

    // Encode only the ' World' addition relative to the existing 'Hello' state
    const svBefore = Y.encodeStateVector(sharedDoc)
    sharedDoc.getText('codemirror').insert(5, ' World')
    const worldOp = Y.encodeStateAsUpdate(sharedDoc, svBefore)
    conn._emit('ReceiveOperation', 'doc-1', 'other-client', bytesToBase64(worldOp))

    const text = await fetcher.getDocumentContent('vault-1', 'doc-1', 'tok')
    expect(text).toBe('Hello World')
  })

  it('handles multiple documents independently', async () => {
    const { fetcher } = makeFetcher({
      'doc-a': [makeYjsOp('Note A')],
      'doc-b': [makeYjsOp('Note B')],
    })
    const [a, b] = await Promise.all([
      fetcher.getDocumentContent('vault-1', 'doc-a', 'tok'),
      fetcher.getDocumentContent('vault-1', 'doc-b', 'tok'),
    ])
    expect(a).toBe('Note A')
    expect(b).toBe('Note B')
  })

  it('applies multiple ops in order', async () => {
    // Use a single doc so both ops share the same CRDT identity
    const doc = new Y.Doc()
    doc.getText('codemirror').insert(0, 'Hello')
    const op1 = bytesToBase64(Y.encodeStateAsUpdate(doc))
    const svAfterOp1 = Y.encodeStateVector(doc)
    doc.getText('codemirror').insert(5, ' World')
    const op2 = bytesToBase64(Y.encodeStateAsUpdate(doc, svAfterOp1))

    const { fetcher } = makeFetcher({ 'doc-1': [op1, op2] })
    const text = await fetcher.getDocumentContent('vault-1', 'doc-1', 'tok')
    expect(text).toBe('Hello World')
  })
})
