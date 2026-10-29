// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Une op ecrite avant que le transport du document soit branche (document
// ouvert juste pour ecrire) est renvoyee quand son etat initial arrive.
import { describe, it, expect, vi } from 'vitest'
import { CollabOrchestrator } from '@savoire/application'
import { decodeSignedOp } from '@savoire/plugin-api'
import type { ICRDT, ITransport, IIdentityProvider } from '@savoire/plugin-api'

describe('CollabOrchestrator : ops ecrites avant la connexion', () => {
  it('sont renvoyees a l arrivee de l etat initial, pas les autres', async () => {
    let localOp!: (op: Uint8Array) => void
    let init!: (ops: Uint8Array[]) => void
    let state: 'connected' | 'connecting' | 'disconnected' = 'connecting'
    const crdt = {
      onLocalOp: (cb: (op: Uint8Array) => void) => { localOp = cb; return () => {} },
      onLocalPresenceChanged: () => () => {},
      applyRemoteOp: vi.fn(),
      getSnapshot: () => new Uint8Array(),
    } as unknown as ICRDT
    const pushed: Uint8Array[] = []
    const transport = {
      push: vi.fn(async (b: Uint8Array) => { if (state === 'connected') pushed.push(b) }),
      pushPresence: async () => {}, pushSnapshot: async () => {},
      onInit: (cb: (ops: Uint8Array[]) => void) => { init = cb; return () => {} },
      onRemoteOp: () => () => {}, onRemotePresence: () => () => {},
      getState: () => state,
    } as unknown as ITransport
    const identity: IIdentityProvider = { getPublicKey: () => new Uint8Array(32), sign: async () => new Uint8Array(64) }
    new CollabOrchestrator(crdt, transport, identity)
    localOp(new Uint8Array([1]))
    await new Promise(r => setTimeout(r, 0))
    expect(pushed).toHaveLength(0) // jetee par le transport
    state = 'connected'
    init([])
    localOp(new Uint8Array([2]))
    await vi.waitFor(() => expect(pushed).toHaveLength(2))
    expect(pushed.map(b => [...decodeSignedOp(b).op]).sort()).toEqual([[1], [2]])
  })
})
