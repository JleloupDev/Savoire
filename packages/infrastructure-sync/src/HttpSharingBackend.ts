// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import { serverUrl } from './serverAddress'
import { fetchWithRenewal } from './http'
import type {
  ISharingBackend, SharedDocumentHandle,
  AppResourceSharing, AppResourcePermission, AppShareLink, AppShareLinkAccess, AppUserLookup, ShareLinkOptions,
  AppAclTarget, AppAclView, IAclApi,
} from '@savoire/application'
import { YjsCrdtAdapter } from './YjsCrdtAdapter'
import { SignalRTransport } from './SignalRTransport'
import { DocumentRoomClient } from './DocumentRoomClient'
import { RestVaultStorage } from './RestVaultStorage'
import { SharedNoteAttachments } from './SharedNoteAttachments'

export class HttpSharingBackend implements ISharingBackend, IAclApi {
  constructor(private readonly baseUrl: string = '') {}

  private resourcePath(resourceType: 'vault' | 'document', id: string): string {
    return serverUrl(`/api/v1/${resourceType === 'vault' ? 'vaults' : 'documents'}/${encodeURIComponent(id)}`, this.baseUrl)
  }

  private async fetch<T>(url: string, token: string, init?: RequestInit): Promise<T> {
    const res = await fetchWithRenewal(globalThis.fetch.bind(globalThis), url, {
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

  // ── Droits herites (ACL) ────────────────────────────────────────────────

  private aclPath(vaultId: string, suffix = ''): string {
    return serverUrl(`/api/v1/vaults/${encodeURIComponent(vaultId)}/acl${suffix}`, this.baseUrl)
  }

  private static aclQuery(target: AppAclTarget): string {
    const q = new URLSearchParams()
    if (target.docId) q.set('docId', target.docId)
    if (target.folder !== undefined) q.set('folder', target.folder)
    return q.toString()
  }

  getAcl(vaultId: string, target: AppAclTarget, token: string): Promise<AppAclView> {
    return this.fetch(`${this.aclPath(vaultId)}?${HttpSharingBackend.aclQuery(target)}`, token)
  }

  setAclInherit(vaultId: string, target: AppAclTarget, inherit: boolean, token: string): Promise<void> {
    return this.fetch(this.aclPath(vaultId, '/inherit'), token, { method: 'PUT', body: JSON.stringify({ ...target, inherit }) })
  }

  setAclEntry(vaultId: string, target: AppAclTarget, subjectId: string, permission: string, token: string): Promise<void> {
    return this.fetch(this.aclPath(vaultId, '/entries'), token, { method: 'PUT', body: JSON.stringify({ ...target, subjectId, permission }) })
  }

  removeAclEntry(vaultId: string, target: AppAclTarget, subjectId: string, token: string): Promise<void> {
    const q = new URLSearchParams(HttpSharingBackend.aclQuery(target))
    q.set('subjectId', subjectId)
    return this.fetch(`${this.aclPath(vaultId, '/entries')}?${q}`, token, { method: 'DELETE' })
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
    const res = await fetchWithRenewal(globalThis.fetch.bind(globalThis), serverUrl(`/api/v1/users?email=${encodeURIComponent(email)}`, this.baseUrl), {
      headers: { Authorization: `Bearer ${token}` },
    })
    if (res.status === 404) return null
    if (!res.ok) throw new Error(`${res.status}`)
    return res.json() as Promise<AppUserLookup>
  }

  createShareLink(resourceType: 'vault' | 'document', id: string, permission: string, token: string, path?: string, options?: ShareLinkOptions): Promise<AppShareLink> {
    const body: Record<string, unknown> = { permission }
    if (resourceType === 'document') {
      if (path) body.path = path
      if (options?.scope) body.scope = options.scope
      if (options?.scope === 'linked') body.documents = options.documents ?? []
    }
    return this.fetch(`${this.resourcePath(resourceType, id)}/sharing/links`, token, {
      method: 'POST',
      body: JSON.stringify(body),
    })
  }

  revokeShareLink(linkId: string, token: string): Promise<void> {
    return this.fetch(serverUrl(`/api/v1/sharing/links/${encodeURIComponent(linkId)}`, this.baseUrl), token, {
      method: 'DELETE',
    })
  }

  async accessShareLink(shareToken: string): Promise<AppShareLinkAccess> {
    const res = await fetch(serverUrl(`/api/v1/share/${encodeURIComponent(shareToken)}/access`, this.baseUrl))
    if (!res.ok) throw new Error(`${res.status}`)
    return res.json() as Promise<AppShareLinkAccess>
  }

  async openSharedDocument(shareToken: string, docId?: string): Promise<Omit<SharedDocumentHandle, 'dispose'>> {
    const res = await fetch(serverUrl(`/api/v1/share/${encodeURIComponent(shareToken)}/access`, this.baseUrl))
    if (!res.ok) throw new Error(`${res.status}`)
    const access = await res.json() as AppShareLinkAccess
    const documents = access.documents?.length ? access.documents : [{ id: access.resourceId, path: access.path ?? null }]
    // Un document du lien (sous-page, page liee), sinon sa page.
    const entry = (docId && documents.find(d => d.id === docId)) || documents[0]
    const resourceId = entry.id

    const path = entry.path ?? (resourceId === access.resourceId ? access.path : undefined) ?? `doc-${resourceId}.md`
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

    // Les images rangees dans le dossier de la note, lues avec le jeton du lien.
    const attachments = access.vaultId
      ? new SharedNoteAttachments(new RestVaultStorage({ baseUrl: this.baseUrl }), access.vaultId, resourceId, () => access.accessToken)
      : undefined

    return {
      crdt,
      transport,
      sync,
      attachments,
      docId: resourceId,
      vaultId: access.vaultId ?? '',
      path,
      filename: path.split('/').at(-1) ?? path,
      permission: access.permission as 'read' | 'write',
      accessToken: access.accessToken,
      documents,
    }
  }
}
