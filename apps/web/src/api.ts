// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import type { VaultSummary, DocumentDto, FolderDto, AuthResponse, AdminUserDto, UserDto, ResourceSharingDto, ResourcePermissionDto, ShareLinkDto, ShareLinkAccessDto } from './types'

async function apiFetch<T>(url: string, token: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      ...init?.headers,
    },
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`${res.status}: ${body}`)
  }
  if (res.status === 204) return undefined as T
  return res.json() as Promise<T>
}

export const api = {
  // ── Auth ─────────────────────────────────────────────────────────────────
  login: (email: string, password: string): Promise<AuthResponse> =>
    fetch('/api/v1/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    }).then(async res => {
      if (!res.ok) throw new Error(`${res.status}`)
      return res.json()
    }),

  refresh: (refreshToken: string): Promise<AuthResponse> =>
    fetch('/api/v1/auth/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
    }).then(async res => {
      if (!res.ok) throw new Error(`${res.status}`)
      return res.json()
    }),

  logout: (accessToken: string, refreshToken: string): Promise<void> =>
    fetch('/api/v1/auth/logout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ refreshToken }),
    }).then(() => undefined),

  changePassword: (token: string, currentPassword: string, newPassword: string): Promise<void> =>
    apiFetch('/api/v1/auth/change-password', token, {
      method: 'POST',
      body: JSON.stringify({ currentPassword, newPassword }),
    }),

  // ── Vaults ───────────────────────────────────────────────────────────────
  listVaults: (userId: string, token: string): Promise<VaultSummary[]> =>
    apiFetch(`/api/v1/users/${encodeURIComponent(userId)}/vaults`, token),

  createVault: (userId: string, name: string, token: string): Promise<VaultSummary> =>
    apiFetch(`/api/v1/users/${encodeURIComponent(userId)}/vaults`, token, {
      method: 'POST',
      body: JSON.stringify({ name }),
    }),

  renameVault: (vaultId: string, name: string, token: string): Promise<VaultSummary> =>
    apiFetch(`/api/v1/vaults/${encodeURIComponent(vaultId)}`, token, {
      method: 'PATCH',
      body: JSON.stringify({ name }),
    }),

  deleteVault: (vaultId: string, token: string): Promise<void> =>
    apiFetch(`/api/v1/vaults/${encodeURIComponent(vaultId)}`, token, { method: 'DELETE' }),

  // ── Folders ──────────────────────────────────────────────────────────────
  listFolders: (vaultId: string, token: string): Promise<FolderDto[]> =>
    apiFetch(`/api/v1/vaults/${encodeURIComponent(vaultId)}/folders`, token),

  createFolder: (vaultId: string, path: string, token: string): Promise<FolderDto> =>
    apiFetch(`/api/v1/vaults/${encodeURIComponent(vaultId)}/folders`, token, {
      method: 'POST',
      body: JSON.stringify({ path }),
    }),

  deleteFolder: (vaultId: string, folderId: string, token: string): Promise<void> =>
    apiFetch(`/api/v1/vaults/${encodeURIComponent(vaultId)}/folders/${encodeURIComponent(folderId)}`, token, {
      method: 'DELETE',
    }),

  // ── Documents ────────────────────────────────────────────────────────────
  listDocuments: (vaultId: string, token: string): Promise<DocumentDto[]> =>
    apiFetch(`/api/v1/vaults/${encodeURIComponent(vaultId)}/documents`, token),

  // ── Attachments (accès direct pour usage interne si besoin) ─────────────
  attachmentUrl: (vaultId: string, path: string): string =>
    `/api/v1/vaults/${encodeURIComponent(vaultId)}/attachments/${encodeURIComponent(path)}`,

  // ── Sharing ───────────────────────────────────────────────────────────────

  getSharing: (rt: 'vault' | 'document', id: string, token: string): Promise<ResourceSharingDto> =>
    apiFetch(`/api/v1/${rt === 'vault' ? 'vaults' : 'documents'}/${encodeURIComponent(id)}/sharing`, token),

  grantPermission: (rt: 'vault' | 'document', id: string, subjectId: string, permission: string, token: string): Promise<ResourcePermissionDto> =>
    apiFetch(`/api/v1/${rt === 'vault' ? 'vaults' : 'documents'}/${encodeURIComponent(id)}/sharing/permissions`, token, {
      method: 'POST',
      body: JSON.stringify({ subjectId, permission }),
    }),

  revokePermission: (rt: 'vault' | 'document', id: string, targetUserId: string, token: string): Promise<void> =>
    apiFetch(`/api/v1/${rt === 'vault' ? 'vaults' : 'documents'}/${encodeURIComponent(id)}/sharing/permissions/${encodeURIComponent(targetUserId)}`, token, { method: 'DELETE' }),

  createShareLink: (rt: 'vault' | 'document', id: string, permission: string, token: string): Promise<ShareLinkDto> =>
    apiFetch(`/api/v1/${rt === 'vault' ? 'vaults' : 'documents'}/${encodeURIComponent(id)}/sharing/links`, token, {
      method: 'POST',
      body: JSON.stringify({ permission }),
    }),

  revokeShareLink: (linkId: string, token: string): Promise<void> =>
    apiFetch(`/api/v1/sharing/links/${encodeURIComponent(linkId)}`, token, { method: 'DELETE' }),

  getDocumentContent: (vaultId: string, docId: string, token: string): Promise<string> =>
    fetch(`/api/v1/vaults/${encodeURIComponent(vaultId)}/documents/${encodeURIComponent(docId)}/content`, {
      headers: { Authorization: `Bearer ${token}` },
    }).then(async res => {
      if (res.status === 404) return ''
      if (!res.ok) throw new Error(`${res.status}`)
      return res.text()
    }),

  putDocumentContent: (vaultId: string, docId: string, token: string, content: string): Promise<void> =>
    fetch(`/api/v1/vaults/${encodeURIComponent(vaultId)}/documents/${encodeURIComponent(docId)}/content`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'text/plain',
      },
      body: content,
    }).then(async res => {
      if (!res.ok) throw new Error(`${res.status}`)
    }),

  accessShareLink: (shareToken: string): Promise<ShareLinkAccessDto> =>
    fetch(`/api/v1/share/${encodeURIComponent(shareToken)}/access`)
      .then(async res => {
        if (!res.ok) throw new Error(`${res.status}`)
        return res.json()
      }),

  // ── Users ─────────────────────────────────────────────────────────────────
  lookupUserByEmail: (email: string, token: string): Promise<UserDto | null> =>
    fetch(`/api/v1/users?email=${encodeURIComponent(email)}`, {
      headers: { Authorization: `Bearer ${token}` },
    }).then(async res => {
      if (res.status === 404) return null
      if (!res.ok) throw new Error(`${res.status}`)
      return res.json() as Promise<UserDto>
    }),

  // ── Admin ─────────────────────────────────────────────────────────────────
  listUsers: (token: string): Promise<AdminUserDto[]> =>
    apiFetch('/api/v1/admin/users', token),

  createUser: (token: string, email: string, password: string, displayName: string, isAdmin: boolean): Promise<void> =>
    apiFetch('/api/v1/admin/users', token, {
      method: 'POST',
      body: JSON.stringify({ email, password, displayName, isAdmin }),
    }),

  resetPassword: (token: string, userId: string, newPassword: string): Promise<void> =>
    apiFetch(`/api/v1/admin/users/${userId}/reset-password`, token, {
      method: 'POST',
      body: JSON.stringify({ newPassword }),
    }),

  revokeSessions: (token: string, userId: string): Promise<void> =>
    apiFetch(`/api/v1/admin/users/${userId}/revoke-sessions`, token, { method: 'POST' }),

  disableUser: (token: string, userId: string): Promise<void> =>
    apiFetch(`/api/v1/admin/users/${userId}/disable`, token, { method: 'POST' }),
}
