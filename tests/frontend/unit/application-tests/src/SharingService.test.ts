// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import { describe, it, expect, vi } from 'vitest'
import { SharingService } from '@savoire/application'
import type {
  ISharingBackend,
  AppResourceSharing,
  AppResourcePermission,
  AppShareLink,
  AppShareLinkAccess,
  AppUserLookup,
} from '@savoire/application'

function makeBackend(): ISharingBackend {
  return {
    getSharing: vi.fn(),
    grantPermission: vi.fn(),
    revokePermission: vi.fn(),
    lookupUserByEmail: vi.fn(),
    createShareLink: vi.fn(),
    revokeShareLink: vi.fn(),
    accessShareLink: vi.fn(),
  }
}

const PERMISSION: AppResourcePermission = {
  id: 'perm1',
  resourceType: 'vault',
  resourceId: 'v1',
  subjectType: 'user',
  subjectId: 'u2',
  subjectDisplayName: 'Bob',
  permission: 'read',
  grantedBy: 'u1',
  grantedAt: '2026-01-01T00:00:00.000Z',
  expiresAt: null,
}

const SHARE_LINK: AppShareLink = {
  id: 'link1',
  token: 'tok123',
  resourceType: 'document',
  resourceId: 'd1',
  permission: 'read',
  createdBy: 'u1',
  createdAt: '2026-01-01T00:00:00.000Z',
  expiresAt: null,
  revokedAt: null,
  isValid: true,
}

const SHARING: AppResourceSharing = {
  resourceType: 'vault',
  resourceId: 'v1',
  permissions: [PERMISSION],
  links: [SHARE_LINK],
}

describe('SharingService', () => {
  it('getSharing delegates to backend.getSharing', async () => {
    const backend = makeBackend()
    vi.mocked(backend.getSharing).mockResolvedValue(SHARING)
    const svc = new SharingService(backend)
    const result = await svc.getSharing('vault', 'v1', 'token')
    expect(result).toEqual(SHARING)
    expect(backend.getSharing).toHaveBeenCalledWith('vault', 'v1', 'token')
  })

  it('grantPermission delegates to backend.grantPermission', async () => {
    const backend = makeBackend()
    vi.mocked(backend.grantPermission).mockResolvedValue(PERMISSION)
    const svc = new SharingService(backend)
    const result = await svc.grantPermission('vault', 'v1', 'u2', 'read', 'token')
    expect(result).toEqual(PERMISSION)
    expect(backend.grantPermission).toHaveBeenCalledWith('vault', 'v1', 'u2', 'read', 'token')
  })

  it('revokePermission delegates to backend.revokePermission', async () => {
    const backend = makeBackend()
    vi.mocked(backend.revokePermission).mockResolvedValue(undefined)
    const svc = new SharingService(backend)
    await svc.revokePermission('vault', 'v1', 'u2', 'token')
    expect(backend.revokePermission).toHaveBeenCalledWith('vault', 'v1', 'u2', 'token')
  })

  it('lookupUserByEmail returns user when found', async () => {
    const backend = makeBackend()
    const user: AppUserLookup = { id: 'u2', displayName: 'Bob' }
    vi.mocked(backend.lookupUserByEmail).mockResolvedValue(user)
    const svc = new SharingService(backend)
    const result = await svc.lookupUserByEmail('bob@example.com', 'token')
    expect(result).toEqual(user)
    expect(backend.lookupUserByEmail).toHaveBeenCalledWith('bob@example.com', 'token')
  })

  it('lookupUserByEmail returns null when not found', async () => {
    const backend = makeBackend()
    vi.mocked(backend.lookupUserByEmail).mockResolvedValue(null)
    const svc = new SharingService(backend)
    const result = await svc.lookupUserByEmail('unknown@example.com', 'token')
    expect(result).toBeNull()
  })

  it('createShareLink delegates to backend.createShareLink', async () => {
    const backend = makeBackend()
    vi.mocked(backend.createShareLink).mockResolvedValue(SHARE_LINK)
    const svc = new SharingService(backend)
    const result = await svc.createShareLink('document', 'd1', 'read', 'token')
    expect(result).toEqual(SHARE_LINK)
    expect(backend.createShareLink).toHaveBeenCalledWith('document', 'd1', 'read', 'token')
  })

  it('revokeShareLink delegates to backend.revokeShareLink', async () => {
    const backend = makeBackend()
    vi.mocked(backend.revokeShareLink).mockResolvedValue(undefined)
    const svc = new SharingService(backend)
    await svc.revokeShareLink('link1', 'token')
    expect(backend.revokeShareLink).toHaveBeenCalledWith('link1', 'token')
  })

  it('accessShareLink delegates to backend.accessShareLink', async () => {
    const backend = makeBackend()
    const access: AppShareLinkAccess = {
      accessToken: 'at',
      resourceType: 'document',
      resourceId: 'd1',
      permission: 'read',
      expiresAt: null,
    }
    vi.mocked(backend.accessShareLink).mockResolvedValue(access)
    const svc = new SharingService(backend)
    const result = await svc.accessShareLink('tok123')
    expect(result).toEqual(access)
    expect(backend.accessShareLink).toHaveBeenCalledWith('tok123')
  })

  it('propagates error from backend.getSharing', async () => {
    const backend = makeBackend()
    vi.mocked(backend.getSharing).mockRejectedValue(new Error('404'))
    const svc = new SharingService(backend)
    await expect(svc.getSharing('vault', 'missing', 'token')).rejects.toThrow('404')
  })
})
