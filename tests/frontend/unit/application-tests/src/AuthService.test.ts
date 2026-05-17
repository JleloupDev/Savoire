// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import { describe, it, expect, vi } from 'vitest'
import { AuthService } from '@savoire/application'
import type { IAuthBackend, AppAuthResponse } from '@savoire/application'

function makeBackend(): IAuthBackend {
  return {
    login: vi.fn(),
    refresh: vi.fn(),
    logout: vi.fn(),
    changePassword: vi.fn(),
  }
}

const AUTH_RESPONSE: AppAuthResponse = {
  accessToken: 'access-token',
  refreshToken: 'refresh-token',
  expiresIn: 3600,
  user: { id: 'u1', displayName: 'Alice', email: 'alice@example.com', isAdmin: false },
}

describe('AuthService', () => {
  it('login delegates to backend.login', async () => {
    const backend = makeBackend()
    vi.mocked(backend.login).mockResolvedValue(AUTH_RESPONSE)
    const svc = new AuthService(backend)
    const result = await svc.login('alice@example.com', 'password')
    expect(result).toEqual(AUTH_RESPONSE)
    expect(backend.login).toHaveBeenCalledWith('alice@example.com', 'password')
  })

  it('refresh delegates to backend.refresh', async () => {
    const backend = makeBackend()
    vi.mocked(backend.refresh).mockResolvedValue(AUTH_RESPONSE)
    const svc = new AuthService(backend)
    const result = await svc.refresh('refresh-token')
    expect(result).toEqual(AUTH_RESPONSE)
    expect(backend.refresh).toHaveBeenCalledWith('refresh-token')
  })

  it('logout delegates to backend.logout', async () => {
    const backend = makeBackend()
    vi.mocked(backend.logout).mockResolvedValue(undefined)
    const svc = new AuthService(backend)
    await svc.logout('access-token', 'refresh-token')
    expect(backend.logout).toHaveBeenCalledWith('access-token', 'refresh-token')
  })

  it('changePassword delegates to backend.changePassword', async () => {
    const backend = makeBackend()
    vi.mocked(backend.changePassword).mockResolvedValue(undefined)
    const svc = new AuthService(backend)
    await svc.changePassword('access-token', 'old', 'new')
    expect(backend.changePassword).toHaveBeenCalledWith('access-token', 'old', 'new')
  })

  it('propagates error from backend.login', async () => {
    const backend = makeBackend()
    vi.mocked(backend.login).mockRejectedValue(new Error('401'))
    const svc = new AuthService(backend)
    await expect(svc.login('x', 'wrong')).rejects.toThrow('401')
  })

  it('propagates error from backend.refresh', async () => {
    const backend = makeBackend()
    vi.mocked(backend.refresh).mockRejectedValue(new Error('401'))
    const svc = new AuthService(backend)
    await expect(svc.refresh('expired')).rejects.toThrow('401')
  })
})
