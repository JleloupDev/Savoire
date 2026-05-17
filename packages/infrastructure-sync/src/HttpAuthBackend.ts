// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import type { IAuthBackend, AppAuthResponse } from '@savoire/application'

export class HttpAuthBackend implements IAuthBackend {
  constructor(private readonly baseUrl: string = '') {}

  async login(email: string, password: string): Promise<AppAuthResponse> {
    const res = await fetch(`${this.baseUrl}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    })
    if (!res.ok) throw new Error(`${res.status}`)
    return res.json() as Promise<AppAuthResponse>
  }

  async refresh(refreshToken: string): Promise<AppAuthResponse> {
    const res = await fetch(`${this.baseUrl}/api/v1/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
    })
    if (!res.ok) throw new Error(`${res.status}`)
    return res.json() as Promise<AppAuthResponse>
  }

  async logout(accessToken: string, refreshToken: string): Promise<void> {
    await fetch(`${this.baseUrl}/api/v1/auth/logout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ refreshToken }),
    })
  }

  async changePassword(token: string, currentPassword: string, newPassword: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/api/v1/auth/change-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ currentPassword, newPassword }),
    })
    if (!res.ok) throw new Error(`${res.status}`)
  }
}
