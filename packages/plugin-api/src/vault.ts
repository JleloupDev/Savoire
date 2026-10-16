// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// ─── Vault API ─────────────────────────────────────────────────────────────

/** Un document de la corbeille. */
export interface TrashEntry {
  documentId: string
  /** Chemin dans la corbeille, par exemple ".trash/Projet/Note.md". */
  path: string
  /** Chemin d'origine, par exemple "Projet/Note.md". */
  originalPath: string
}

/** Options d'envoi d'une piece jointe. */
export interface AttachmentUploadOptions {
  /** Note depuis laquelle on envoie : la piece jointe va dans son dossier. */
  notePath?: string
}

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
  /**
   * Met le document a la corbeille (`.trash/`, comme Obsidian) : rien n'est
   * efface. Voir restoreFromTrash et deleteFilePermanently.
   */
  deleteFile?(documentId: string): Promise<void>
  /**
   * Met a la corbeille tous les documents du dossier, a toute profondeur, et
   * retire ses entrees de dossier (les dossiers vides ne sont pas gardes).
   */
  deleteFolder?(path: string): Promise<void>
  /** Documents de la corbeille. */
  listTrash?(): TrashEntry[]
  /** Vrai si le document est dans la corbeille. */
  isTrashed?(documentId: string): boolean
  /** Remet le document a son chemin d'origine (suffixe s'il est pris). Rend le chemin restaure. */
  restoreFromTrash?(documentId: string): Promise<string>
  /** Supprime definitivement un document de la corbeille. Refuse un document hors corbeille. */
  deleteFilePermanently?(documentId: string): Promise<void>
  /**
   * Envoie un fichier (image...) sous son nom d'origine (« Nom 1.png » en cas
   * de collision). Avec `notePath`, il est range dans le dossier de cette
   * note (`Dossier/Ma note.md` -> `Dossier/Ma note/`, comme une note de
   * dossier) ; sans, dans `attachments/`. Rend le chemin cree.
   */
  uploadAttachment?(file: File, options?: AttachmentUploadOptions): Promise<string>
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
