// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import { describe, it, expect, vi } from 'vitest'
import { AuthService } from '@savoire/application'
import type { IAuthBackend, AppAuthResponse, PendingLogin } from '@savoire/application'

function makeBackend(): IAuthBackend {
  return {
    config: vi.fn(),
    beginLogin: vi.fn(),
    completeLogin: vi.fn(),
    refresh: vi.fn(),
    logout: vi.fn(),
    endSessionUrl: vi.fn(),
  }
}

const PENDING: PendingLogin = {
  issuer: 'https://idp.test', clientId: 'web', redirectUri: 'https://app.test/auth/callback',
  state: 's', codeVerifier: 'v', tokenEndpoint: 'https://idp.test/token',
}

const AUTH_RESPONSE: AppAuthResponse = {
  accessToken: 'access-token',
  refreshToken: 'refresh-token',
  expiresIn: 3600,
  user: { id: 'u1', displayName: 'Alice', email: 'alice@example.com', isAdmin: false },
}

describe('AuthService', () => {
  it('beginLogin and completeLogin delegate to the backend', async () => {
    const backend = makeBackend()
    vi.mocked(backend.beginLogin).mockResolvedValue({ url: 'https://idp.test/authorize?x', pending: PENDING })
    vi.mocked(backend.completeLogin).mockResolvedValue(AUTH_RESPONSE)
    const svc = new AuthService(backend)
    expect(await svc.beginLogin('https://app.test/auth/callback', 'create')).toEqual({ url: 'https://idp.test/authorize?x', pending: PENDING })
    expect(backend.beginLogin).toHaveBeenCalledWith('https://app.test/auth/callback', 'create')
    const params = new URLSearchParams('code=c&state=s')
    expect(await svc.completeLogin(PENDING, params)).toEqual(AUTH_RESPONSE)
    expect(backend.completeLogin).toHaveBeenCalledWith(PENDING, params)
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

  it('propagates error from backend.completeLogin', async () => {
    const backend = makeBackend()
    vi.mocked(backend.completeLogin).mockRejectedValue(new Error('401'))
    const svc = new AuthService(backend)
    await expect(svc.completeLogin(PENDING, new URLSearchParams())).rejects.toThrow('401')
  })

  it('propagates error from backend.refresh', async () => {
    const backend = makeBackend()
    vi.mocked(backend.refresh).mockRejectedValue(new Error('401'))
    const svc = new AuthService(backend)
    await expect(svc.refresh('expired')).rejects.toThrow('401')
  })
})
