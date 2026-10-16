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
  /**
   * Envoie un fichier (image, PDF...) dans `attachments/`, sous son nom
   * d'origine (« Nom 1.png » en cas de collision). Rend le chemin lisible,
   * par exemple "attachments/Nom.png".
   */
  uploadAttachment?(file: File): Promise<string>
  /**
   * URL affichable (<img src>) d'une piece jointe, designee par son chemin ou
   * par son seul nom (« Nom.png », comme Obsidian). Asynchrone : la lecture
   * est autorisee avant d'etre affichee (URL blob:). Rejette si introuvable.
   */
  resolveAttachmentUrl?(path: string): Promise<string>
  /** Texte d'un lien `![[...]]` vers ce chemin : le nom seul s'il est unique dans le vault, sinon le chemin. */
  linkTarget?(path: string): string
  /** Returns the vault id — used by embedded views to open DocumentRoom. */
  getVaultId?(): string
  /** Returns the current bearer token — used by embedded views for scoped API calls. */
  getToken?(): string
  /** Returns Level 1 gossipable metadata for all known documents. */
  getFileTree?(): import('./indexing').FileTreeEntry[]
  /** Returns Level 2 metadata (title, tags, aliases, frontmatter) for a document. */
  getMetadata?(docId: string): import('./indexing').DocMetadata | null
}
