// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { CollabOrchestrator } from '@savoire/application'
import { decodeSignedOp } from '@savoire/plugin-api'
import type { ICRDT, ITransport, IIdentityProvider } from '@savoire/plugin-api'

// ── Factories ─────────────────────────────────────────────────────────────────

function makeCrdt(): ICRDT {
  return {
    onLocalOp: vi.fn(() => vi.fn()),
    onLocalPresenceChanged: vi.fn(() => vi.fn()),
    applyRemoteOp: vi.fn(),
    applyRemotePresence: vi.fn(),
    encodeLocalPresence: vi.fn(() => new Uint8Array()),
    getRemoteCursorPositions: vi.fn(() => []),
    getSnapshot: vi.fn(() => new Uint8Array([0xff])),
    onTextChange: vi.fn(() => vi.fn()),
    getVersion: vi.fn(() => ({ clock: 0, clientId: 0 })),
    dispose: vi.fn(),
  } as unknown as ICRDT
}

function makeTransport(): ITransport {
  return {
    push: vi.fn(async () => {}),
    pushPresence: vi.fn(async () => {}),
    pushSnapshot: vi.fn(async () => {}),
    onInit: vi.fn(() => vi.fn()),
    onRemoteOp: vi.fn(() => vi.fn()),
    onRemotePresence: vi.fn(() => vi.fn()),
    getState: vi.fn(() => 'disconnected' as const),
    join: vi.fn(async () => {}),
    disconnect: vi.fn(async () => {}),
  }
}

function makeIdentity(
  pubKey = new Uint8Array(32).fill(0x01),
  sig = new Uint8Array(64).fill(0x02),
): IIdentityProvider {
  return {
    getPublicKey: vi.fn(() => pubKey),
    sign: vi.fn(async () => sig),
  }
}

function captureCallback<T>(mockFn: ReturnType<typeof vi.fn>): T {
  return mockFn.mock.calls[0][0] as T
}

beforeEach(() => {
  vi.clearAllMocks()
})

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('CollabOrchestrator', () => {
  it('signs and encodes local ops before pushing to transport', async () => {
    const pubKey = new Uint8Array(32).fill(0x01)
    const sig = new Uint8Array(64).fill(0x02)
    const identity = makeIdentity(pubKey, sig)
    const crdt = makeCrdt()
    const transport = makeTransport()

    const orchestrator = new CollabOrchestrator(crdt, transport, identity)
    const onLocalOp = captureCallback<(op: Uint8Array) => void>(vi.mocked(crdt.onLocalOp))

    const op = new Uint8Array([1, 2, 3])
    onLocalOp(op)
    await vi.waitFor(() => expect(transport.push).toHaveBeenCalledOnce())

    const pushed = vi.mocked(transport.push).mock.calls[0][0] as Uint8Array
    const decoded = decodeSignedOp(pushed)
    expect(decoded.op).toEqual(op)
    expect(decoded.signature).toEqual(sig)
    expect(decoded.signerPublicKey).toEqual(pubKey)

    orchestrator.dispose()
  })

  it('logs error and skips push when signing fails', async () => {
    const identity = makeIdentity()
    vi.mocked(identity.sign).mockRejectedValue(new Error('auth expired'))
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const crdt = makeCrdt()
    const transport = makeTransport()

    const orchestrator = new CollabOrchestrator(crdt, transport, identity)
    const onLocalOp = captureCallback<(op: Uint8Array) => void>(vi.mocked(crdt.onLocalOp))

    onLocalOp(new Uint8Array([9]))
    await new Promise(r => setTimeout(r, 10))

    expect(transport.push).not.toHaveBeenCalled()
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('CollabOrchestrator'),
      expect.any(Error),
    )

    errorSpy.mockRestore()
    orchestrator.dispose()
  })

  it('forwards remote ops to CRDT', () => {
    const crdt = makeCrdt()
    const transport = makeTransport()
    const orchestrator = new CollabOrchestrator(crdt, transport, makeIdentity())

    const onRemoteOp = captureCallback<(op: Uint8Array) => void>(vi.mocked(transport.onRemoteOp))
    const op = new Uint8Array([7, 8, 9])
    onRemoteOp(op)

    expect(crdt.applyRemoteOp).toHaveBeenCalledWith(op)
    orchestrator.dispose()
  })

  it('forwards remote presence to CRDT', () => {
    const crdt = makeCrdt()
    const transport = makeTransport()
    const orchestrator = new CollabOrchestrator(crdt, transport, makeIdentity())

    const onPresence = captureCallback<(bytes: Uint8Array) => void>(vi.mocked(transport.onRemotePresence))
    const bytes = new Uint8Array([5, 6])
    onPresence(bytes)

    expect(crdt.applyRemotePresence).toHaveBeenCalledWith(bytes)
    orchestrator.dispose()
  })

  it('forwards local presence to transport', () => {
    const crdt = makeCrdt()
    const transport = makeTransport()
    const orchestrator = new CollabOrchestrator(crdt, transport, makeIdentity())

    const onLocalPresence = captureCallback<(bytes: Uint8Array, clients: number[]) => void>(
      vi.mocked(crdt.onLocalPresenceChanged),
    )
    const bytes = new Uint8Array([3, 4])
    onLocalPresence(bytes, [])

    expect(transport.pushPresence).toHaveBeenCalledWith(bytes)
    orchestrator.dispose()
  })

  it('applies all init ops to CRDT', () => {
    const crdt = makeCrdt()
    const transport = makeTransport()
    const orchestrator = new CollabOrchestrator(crdt, transport, makeIdentity())

    const onInit = captureCallback<(ops: Uint8Array[]) => void>(vi.mocked(transport.onInit))
    const ops = [new Uint8Array([1]), new Uint8Array([2]), new Uint8Array([3])]
    onInit(ops)

    expect(crdt.applyRemoteOp).toHaveBeenCalledTimes(3)
    ops.forEach((op, i) => expect(crdt.applyRemoteOp).toHaveBeenNthCalledWith(i + 1, op))
    orchestrator.dispose()
  })

  it('pushes snapshot when init op count exceeds 100', () => {
    const snapshot = new Uint8Array([0xfe, 0xed])
    const crdt = makeCrdt()
    vi.mocked(crdt.getSnapshot).mockReturnValue(snapshot)
    const transport = makeTransport()
    const orchestrator = new CollabOrchestrator(crdt, transport, makeIdentity())

    const onInit = captureCallback<(ops: Uint8Array[]) => void>(vi.mocked(transport.onInit))
    onInit(Array.from({ length: 101 }, () => new Uint8Array([0])))

    expect(transport.pushSnapshot).toHaveBeenCalledWith(snapshot)
    orchestrator.dispose()
  })

  it('does not push snapshot when init op count equals 100', () => {
    const crdt = makeCrdt()
    const transport = makeTransport()
    const orchestrator = new CollabOrchestrator(crdt, transport, makeIdentity())

    const onInit = captureCallback<(ops: Uint8Array[]) => void>(vi.mocked(transport.onInit))
    onInit(Array.from({ length: 100 }, () => new Uint8Array([0])))

    expect(transport.pushSnapshot).not.toHaveBeenCalled()
    orchestrator.dispose()
  })

  it('dispose calls every registered cleanup', () => {
    const cleanups = Array.from({ length: 5 }, () => vi.fn())
    const crdt = makeCrdt()
    const transport = makeTransport()

    vi.mocked(crdt.onLocalOp).mockReturnValue(cleanups[0])
    vi.mocked(crdt.onLocalPresenceChanged).mockReturnValue(cleanups[1])
    vi.mocked(transport.onInit).mockReturnValue(cleanups[2])
    vi.mocked(transport.onRemoteOp).mockReturnValue(cleanups[3])
    vi.mocked(transport.onRemotePresence).mockReturnValue(cleanups[4])

    const orchestrator = new CollabOrchestrator(crdt, transport, makeIdentity())
    orchestrator.dispose()

    cleanups.forEach(fn => expect(fn).toHaveBeenCalledOnce())
  })
})
