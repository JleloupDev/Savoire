// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// ─── Vault API ─────────────────────────────────────────────────────────────

export interface VaultAPI {
  read(documentId: string): Promise<string>
  /** Seule exception path-based: lecture d'un document/attachment via son chemin. */
  readDocumentByPath(path: string): Promise<string>
  write(documentId: string, content: string): Promise<void>
  list(dir?: string): Promise<string[]>
  exists(documentId: string): Promise<boolean>
  /** Resolve a vault-relative path to a document id when possible. */
  resolveDocumentId(path: string): string | undefined
  createFile?(path: string): Promise<void>
  createFolder?(path: string): Promise<void>
  renameFile?(documentId: string, newPath: string): Promise<void>
  deleteFile?(documentId: string): Promise<void>
  deleteFolder?(path: string): Promise<void>
  /** Upload a binary file (image, PDF…); returns the vault-relative readable path, e.g. "attachments/image.png". */
  uploadAttachment?(file: File): Promise<string>
  /** Resolve a vault-relative path to an absolute URL suitable for <img src>. */
  resolveAttachmentUrl?(path: string): string
  /** Returns the vault id — used by embedded views to open DocumentRoom. */
  getVaultId?(): string
  /** Returns the current bearer token — used by embedded views for scoped API calls. */
  getToken?(): string
  /** Returns Level 1 gossipable metadata for all known documents. */
  getFileTree?(): import('./indexing').FileTreeEntry[]
  /** Returns Level 2 metadata (title, tags, aliases, frontmatter) for a document. */
  getMetadata?(docId: string): import('./indexing').DocMetadata | null
}
