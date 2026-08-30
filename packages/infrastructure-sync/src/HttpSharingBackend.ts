// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import type {
  ISharingBackend, SharedDocumentHandle,
  AppResourceSharing, AppResourcePermission, AppShareLink, AppShareLinkAccess, AppUserLookup,
} from '@savoire/application'
import { YjsCrdtAdapter } from './YjsCrdtAdapter'
import { SignalRTransport } from './SignalRTransport'
import { DocumentRoomClient } from './DocumentRoomClient'

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

  async openSharedDocument(shareToken: string): Promise<Omit<SharedDocumentHandle, 'dispose'>> {
    const res = await fetch(`${this.baseUrl}/api/v1/share/${encodeURIComponent(shareToken)}/access`)
    if (!res.ok) throw new Error(`${res.status}`)
    const access = await res.json() as AppShareLinkAccess

    const path = access.path ?? `doc-${access.resourceId}.md`
    const crdt = new YjsCrdtAdapter()
    const transport = new SignalRTransport({
      serverUrl: this.baseUrl,
      userId: 'share',
      getToken: () => access.accessToken,
    })
    const sync = new DocumentRoomClient({
      serverUrl: this.baseUrl,
      getToken: () => access.accessToken,
    })

    return {
      crdt,
      transport,
      sync,
      docId: access.resourceId,
      vaultId: access.vaultId ?? '',
      path,
      filename: path.split('/').at(-1) ?? path,
      permission: access.permission as 'read' | 'write',
      accessToken: access.accessToken,
    }
  }
}
