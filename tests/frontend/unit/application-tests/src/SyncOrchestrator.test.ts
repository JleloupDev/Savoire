// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { SyncOrchestrator } from '@savoire/application'
import type { IVaultHubFactory, VaultHubLike } from '@savoire/application'
import type { VaultClient } from '@savoire/platform'

function makeHub(): VaultHubLike {
  return {
    connect: vi.fn(async () => {}),
    dispose: vi.fn(async () => {}),
    createDocument: vi.fn(async (path: string) => ({ id: 'new-id', path })),
    renameDocument: vi.fn(async () => {}),
    deleteDocument: vi.fn(async () => {}),
  }
}

function makeFactory(hub: VaultHubLike): IVaultHubFactory {
  return {
    create: vi.fn(() => hub),
  }
}

const stubClient = {} as unknown as VaultClient

beforeEach(() => {
  vi.clearAllMocks()
})

describe('SyncOrchestrator', () => {
  it('attachVaultSync creates hub via factory and calls connect()', async () => {
    const hub = makeHub()
    const factory = makeFactory(hub)
    const orchestrator = new SyncOrchestrator(factory)

    const result = await orchestrator.attachVaultSync('v1', stubClient, vi.fn())

    expect(factory.create).toHaveBeenCalledWith({
      vaultId: 'v1',
      vaultClient: stubClient,
      onChanged: expect.any(Function),
    })
    expect(hub.connect).toHaveBeenCalledOnce()
    expect(result).toBe(hub)
  })

  it('attachVaultSync disposes previous hub before creating a new one', async () => {
    const hub1 = makeHub()
    const hub2 = makeHub()
    let call = 0
    const factory: IVaultHubFactory = {
      create: vi.fn(() => (call++ === 0 ? hub1 : hub2)),
    }
    const orchestrator = new SyncOrchestrator(factory)

    await orchestrator.attachVaultSync('v1', stubClient, vi.fn())
    await orchestrator.attachVaultSync('v2', stubClient, vi.fn())

    expect(hub1.dispose).toHaveBeenCalledOnce()
    expect(hub2.connect).toHaveBeenCalledOnce()
  })

  it('disposeActive is a no-op when no active hub', async () => {
    const hub = makeHub()
    const factory = makeFactory(hub)
    const orchestrator = new SyncOrchestrator(factory)
    await expect(orchestrator.disposeActive()).resolves.toBeUndefined()
    expect(hub.dispose).not.toHaveBeenCalled()
  })

  it('disposeActive disposes active hub and clears it', async () => {
    const hub = makeHub()
    const factory = makeFactory(hub)
    const orchestrator = new SyncOrchestrator(factory)

    await orchestrator.attachVaultSync('v1', stubClient, vi.fn())
    await orchestrator.disposeActive()

    expect(hub.dispose).toHaveBeenCalledOnce()

    // A second disposeActive should be a no-op
    await orchestrator.disposeActive()
    expect(hub.dispose).toHaveBeenCalledOnce()
  })

  it('factory receives onChanged callback', async () => {
    const hub = makeHub()
    const factory = makeFactory(hub)
    const orchestrator = new SyncOrchestrator(factory)
    const onChanged = vi.fn()

    await orchestrator.attachVaultSync('v1', stubClient, onChanged)

    expect(factory.create).toHaveBeenCalledWith(
      expect.objectContaining({ onChanged }),
    )
  })
})
