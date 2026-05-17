// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import type { IAdminBackend, AppAdminUser } from '@savoire/application'

export class HttpAdminBackend implements IAdminBackend {
  constructor(private readonly baseUrl: string = '') {}

  private async fetch<T>(url: string, token: string, init?: RequestInit): Promise<T> {
    const res = await fetch(url, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        ...init?.headers,
      },
    })
    if (!res.ok) throw new Error(`${res.status}`)
    if (res.status === 204) return undefined as T
    return res.json() as Promise<T>
  }

  listUsers(token: string): Promise<AppAdminUser[]> {
    return this.fetch(`${this.baseUrl}/api/v1/admin/users`, token)
  }

  createUser(token: string, email: string, password: string, displayName: string, isAdmin: boolean): Promise<void> {
    return this.fetch(`${this.baseUrl}/api/v1/admin/users`, token, {
      method: 'POST',
      body: JSON.stringify({ email, password, displayName, isAdmin }),
    })
  }

  resetPassword(token: string, userId: string, newPassword: string): Promise<void> {
    return this.fetch(`${this.baseUrl}/api/v1/admin/users/${encodeURIComponent(userId)}/reset-password`, token, {
      method: 'POST',
      body: JSON.stringify({ newPassword }),
    })
  }

  revokeSessions(token: string, userId: string): Promise<void> {
    return this.fetch(`${this.baseUrl}/api/v1/admin/users/${encodeURIComponent(userId)}/revoke-sessions`, token, {
      method: 'POST',
    })
  }

  disableUser(token: string, userId: string): Promise<void> {
    return this.fetch(`${this.baseUrl}/api/v1/admin/users/${encodeURIComponent(userId)}/disable`, token, {
      method: 'POST',
    })
  }
}
