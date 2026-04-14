// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// DTOs — miroirs des records C# du serveur

export interface AuthUser {
  id: string
  displayName: string
  email: string
  isAdmin: boolean
}

export interface AuthResponse {
  accessToken: string
  refreshToken: string
  expiresIn: number
  user: AuthUser
}

export interface AccountEntry {
  userId: string
  email: string
  displayName: string
  refreshToken: string
  isActive: boolean
}

export interface VaultSummary {
  id: string
  name: string
  role: string
  documentCount: number
  folderCount: number
  lastModifiedAt: string | null
  sizeBytes: number
}

export interface SharedNote {
  documentId: string
  vaultId: string
  path: string
  permission: string
  grantedByDisplayName: string
}

/** Détail vault retourné par GET /api/v1/vaults/{id} */
export interface VaultDetail extends VaultSummary {
  members?: { userId: string; displayName: string; email: string; role: string }[]
}

export interface DocumentDto {
  id: string
  path: string
  title: string | null
  hash: string
  sizeBytes: number
  createdAt: string
  updatedAt: string
}

export interface FolderDto {
  id: string
  path: string
  createdAt: string
}

// ── Sharing ───────────────────────────────────────────────────────────────────

export interface ResourcePermissionDto {
  id: string
  resourceType: string
  resourceId: string
  subjectType: string
  subjectId: string
  subjectDisplayName: string | null
  permission: string
  grantedBy: string
  grantedAt: string
  expiresAt: string | null
}

export interface ShareLinkDto {
  id: string
  token: string
  resourceType: string
  resourceId: string
  permission: string
  createdBy: string
  createdAt: string
  expiresAt: string | null
  revokedAt: string | null
  isValid: boolean
}

export interface ResourceSharingDto {
  resourceType: string
  resourceId: string
  permissions: ResourcePermissionDto[]
  links: ShareLinkDto[]
}

export interface ShareLinkAccessDto {
  accessToken: string
  resourceType: string
  resourceId: string
  permission: string
  expiresAt: string | null
  /** Returned by backend for resourceType=document (pending backend update to include this). */
  vaultId?: string
}

export interface UserDto {
  id: string
  displayName: string
}

export interface AdminUserDto {
  id: string
  email: string
  displayName: string
  isAdmin: boolean
  createdAt: string
  lastLoginAt: string | null
  isLockedOut: boolean
}
