// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import type {
  ISharingBackend,
  AppResourceSharing, AppResourcePermission, AppShareLink, AppShareLinkAccess, AppUserLookup,
} from '@savoire/application'

export class HttpSharingBackend implements ISharingBackend {
  constructor(private readonly baseUrl: string = '') {}

  private resourcePath(resourceType: 'vault' | 'document', id: string): string {
    return `${this.baseUrl}/api/v1/${resourceType === 'vault' ? 'vaults' : 'documents'}/${encodeURIComponent(id)}`
  }

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

  getSharing(resourceType: 'vault' | 'document', id: string, token: string): Promise<AppResourceSharing> {
    return this.fetch(`${this.resourcePath(resourceType, id)}/sharing`, token)
  }

  grantPermission(resourceType: 'vault' | 'document', id: string, subjectId: string, permission: string, token: string): Promise<AppResourcePermission> {
    return this.fetch(`${this.resourcePath(resourceType, id)}/sharing/permissions`, token, {
      method: 'POST',
      body: JSON.stringify({ subjectId, permission }),
    })
  }

  revokePermission(resourceType: 'vault' | 'document', id: string, targetUserId: string, token: string): Promise<void> {
    return this.fetch(`${this.resourcePath(resourceType, id)}/sharing/permissions/${encodeURIComponent(targetUserId)}`, token, {
      method: 'DELETE',
    })
  }

  async lookupUserByEmail(email: string, token: string): Promise<AppUserLookup | null> {
    const res = await fetch(`${this.baseUrl}/api/v1/users?email=${encodeURIComponent(email)}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    if (res.status === 404) return null
    if (!res.ok) throw new Error(`${res.status}`)
    return res.json() as Promise<AppUserLookup>
  }

  createShareLink(resourceType: 'vault' | 'document', id: string, permission: string, token: string): Promise<AppShareLink> {
    return this.fetch(`${this.resourcePath(resourceType, id)}/sharing/links`, token, {
      method: 'POST',
      body: JSON.stringify({ permission }),
    })
  }

  revokeShareLink(linkId: string, token: string): Promise<void> {
    return this.fetch(`${this.baseUrl}/api/v1/sharing/links/${encodeURIComponent(linkId)}`, token, {
      method: 'DELETE',
    })
  }

  async accessShareLink(shareToken: string): Promise<AppShareLinkAccess> {
    const res = await fetch(`${this.baseUrl}/api/v1/share/${encodeURIComponent(shareToken)}/access`)
    if (!res.ok) throw new Error(`${res.status}`)
    return res.json() as Promise<AppShareLinkAccess>
  }
}
