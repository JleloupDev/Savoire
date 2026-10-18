// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import { serverUrl } from './serverAddress'
import type { IAuthBackend, AppAuthResponse } from '@savoire/application'

export class HttpAuthBackend implements IAuthBackend {
  constructor(private readonly baseUrl: string = '') {}

  async login(email: string, password: string): Promise<AppAuthResponse> {
    const res = await fetch(serverUrl(`/api/v1/auth/login`, this.baseUrl), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    })
    if (!res.ok) throw new Error(`${res.status}`)
    return res.json() as Promise<AppAuthResponse>
  }

  async refresh(refreshToken: string): Promise<AppAuthResponse> {
    const res = await fetch(serverUrl(`/api/v1/auth/refresh`, this.baseUrl), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
    })
    if (!res.ok) throw new Error(`${res.status}`)
    return res.json() as Promise<AppAuthResponse>
  }

  async logout(accessToken: string, refreshToken: string): Promise<void> {
    await fetch(serverUrl(`/api/v1/auth/logout`, this.baseUrl), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ refreshToken }),
    })
  }

  async changePassword(token: string, currentPassword: string, newPassword: string): Promise<void> {
    const res = await fetch(serverUrl(`/api/v1/auth/change-password`, this.baseUrl), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ currentPassword, newPassword }),
    })
    if (!res.ok) throw new Error(`${res.status}`)
  }
}
