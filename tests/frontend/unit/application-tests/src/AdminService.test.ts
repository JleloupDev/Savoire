// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import { describe, it, expect, vi } from 'vitest'
import { AdminService } from '@savoire/application'
import type { IAdminBackend, AppAdminUser } from '@savoire/application'

function makeBackend(): IAdminBackend {
  return {
    listUsers: vi.fn(),
    createUser: vi.fn(),
    resetPassword: vi.fn(),
    revokeSessions: vi.fn(),
    disableUser: vi.fn(),
  }
}

const ADMIN_USER: AppAdminUser = {
  id: 'u1',
  email: 'alice@example.com',
  displayName: 'Alice',
  isAdmin: false,
  createdAt: '2026-01-01T00:00:00.000Z',
  lastLoginAt: '2026-05-01T00:00:00.000Z',
  isLockedOut: false,
}

describe('AdminService', () => {
  it('listUsers delegates to backend.listUsers', async () => {
    const backend = makeBackend()
    vi.mocked(backend.listUsers).mockResolvedValue([ADMIN_USER])
    const svc = new AdminService(backend)
    const result = await svc.listUsers('token')
    expect(result).toEqual([ADMIN_USER])
    expect(backend.listUsers).toHaveBeenCalledWith('token')
  })

  it('createUser delegates to backend.createUser', async () => {
    const backend = makeBackend()
    vi.mocked(backend.createUser).mockResolvedValue(undefined)
    const svc = new AdminService(backend)
    await svc.createUser('token', 'bob@example.com', 'pass', 'Bob', false)
    expect(backend.createUser).toHaveBeenCalledWith('token', 'bob@example.com', 'pass', 'Bob', false)
  })

  it('resetPassword delegates to backend.resetPassword', async () => {
    const backend = makeBackend()
    vi.mocked(backend.resetPassword).mockResolvedValue(undefined)
    const svc = new AdminService(backend)
    await svc.resetPassword('token', 'u1', 'newpass')
    expect(backend.resetPassword).toHaveBeenCalledWith('token', 'u1', 'newpass')
  })

  it('revokeSessions delegates to backend.revokeSessions', async () => {
    const backend = makeBackend()
    vi.mocked(backend.revokeSessions).mockResolvedValue(undefined)
    const svc = new AdminService(backend)
    await svc.revokeSessions('token', 'u1')
    expect(backend.revokeSessions).toHaveBeenCalledWith('token', 'u1')
  })

  it('disableUser delegates to backend.disableUser', async () => {
    const backend = makeBackend()
    vi.mocked(backend.disableUser).mockResolvedValue(undefined)
    const svc = new AdminService(backend)
    await svc.disableUser('token', 'u1')
    expect(backend.disableUser).toHaveBeenCalledWith('token', 'u1')
  })

  it('propagates error from backend.listUsers', async () => {
    const backend = makeBackend()
    vi.mocked(backend.listUsers).mockRejectedValue(new Error('403'))
    const svc = new AdminService(backend)
    await expect(svc.listUsers('bad-token')).rejects.toThrow('403')
  })

  it('propagates error from backend.createUser', async () => {
    const backend = makeBackend()
    vi.mocked(backend.createUser).mockRejectedValue(new Error('409'))
    const svc = new AdminService(backend)
    await expect(svc.createUser('token', 'dup@example.com', 'pass', 'Dup', false)).rejects.toThrow('409')
  })
})
