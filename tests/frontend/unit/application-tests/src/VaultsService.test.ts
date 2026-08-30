// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import { describe, it, expect, vi } from 'vitest'
import { VaultsService } from '@savoire/application'
import type { IVaultsBackend, AppVaultSummary } from '@savoire/application'

function makeBackend(): IVaultsBackend {
  return {
    listVaults: vi.fn(),
    createVault: vi.fn(),
    renameVault: vi.fn(),
    deleteVault: vi.fn(),
    listDocuments: vi.fn(),
  }
}

const VAULT_SUMMARY: AppVaultSummary = {
  id: 'v1',
  name: 'Main',
  role: 'owner',
  documentCount: 3,
  folderCount: 1,
  lastModifiedAt: '2026-01-01T00:00:00.000Z',
  sizeBytes: 1024,
}

describe('VaultsService', () => {
  it('list delegates to backend.listVaults', async () => {
    const backend = makeBackend()
    vi.mocked(backend.listVaults).mockResolvedValue([VAULT_SUMMARY])
    const svc = new VaultsService(backend)
    const result = await svc.list('user1', 'token')
    expect(result).toEqual([VAULT_SUMMARY])
    expect(backend.listVaults).toHaveBeenCalledWith('user1', 'token')
  })

  it('create delegates to backend.createVault', async () => {
    const backend = makeBackend()
    vi.mocked(backend.createVault).mockResolvedValue(VAULT_SUMMARY)
    const svc = new VaultsService(backend)
    const result = await svc.create('user1', 'Main', 'token')
    expect(result).toEqual(VAULT_SUMMARY)
    expect(backend.createVault).toHaveBeenCalledWith('user1', 'Main', 'token')
  })

  it('rename delegates to backend.renameVault', async () => {
    const backend = makeBackend()
    const renamed = { ...VAULT_SUMMARY, name: 'Renamed' }
    vi.mocked(backend.renameVault).mockResolvedValue(renamed)
    const svc = new VaultsService(backend)
    const result = await svc.rename('v1', 'Renamed', 'token')
    expect(result).toEqual(renamed)
    expect(backend.renameVault).toHaveBeenCalledWith('v1', 'Renamed', 'token')
  })

  it('delete delegates to backend.deleteVault', async () => {
    const backend = makeBackend()
    vi.mocked(backend.deleteVault).mockResolvedValue(undefined)
    const svc = new VaultsService(backend)
    await svc.delete('v1', 'token')
    expect(backend.deleteVault).toHaveBeenCalledWith('v1', 'token')
  })

  it('propagates error from backend.listVaults', async () => {
    const backend = makeBackend()
    vi.mocked(backend.listVaults).mockRejectedValue(new Error('Network error'))
    const svc = new VaultsService(backend)
    await expect(svc.list('u1', 'tok')).rejects.toThrow('Network error')
  })

  it('propagates error from backend.createVault', async () => {
    const backend = makeBackend()
    vi.mocked(backend.createVault).mockRejectedValue(new Error('400'))
    const svc = new VaultsService(backend)
    await expect(svc.create('u1', 'bad', 'tok')).rejects.toThrow('400')
  })
})
