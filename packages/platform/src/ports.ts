// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
/**
 * Platform ports - interfaces définies par la couche platform.
 *
 *
 * IDocumentMeta est intentionnellement minimal : la platform ne connaît pas DocumentDto
 * (DTO spécifique à l'API REST). Toute app qui implémente `id` + `path` est compatible.
 */

// ── Document meta ─────────────────────────────────────────────────────────────

/** Interface minimale requise par la platform - sous-ensemble de DocumentDto. */
export interface IDocumentMeta {
  id: string
  path: string
}

// ── Document fetcher port ──────────────────────────────────────────────────────

/** Port : chargement/écriture du contenu textuel d'un document depuis n'importe quelle source. */
export interface IDocumentFetcher {
  getDocumentContent(vaultId: string, docId: string, token: string): Promise<string>
  writeDocumentContent(vaultId: string, docId: string, content: string, token: string): Promise<void>
}

// ── Vault storage port ────────────────────────────────────────────────────────

// ── Local index storage port ──────────────────────────────────────────────────

/**
 * Port : persistance des snapshots d'index local.
 * POC : InMemoryIndexStorage. Production : IndexedDB ou SQLite.
 */
export interface ILocalIndexStorage {
  /** Charge le dernier snapshot pour un namespace. Retourne null si aucun n'existe. */
  loadSnapshot(namespace: string): Promise<{ data: string; seq: number } | null>
  /** Persiste un snapshot pour un namespace. */
  saveSnapshot(namespace: string, data: string, seq: number): Promise<void>
}

// ── Vault directory port ──────────────────────────────────────────────────────

/**
 * Port : liste des documents d'un vault.
 *
 * Abstrait la structure de données sous-jacente (Y.Map aujourd'hui, DAG demain).
 * La frontière binaire (Uint8Array) rend le transport aveugle au CRDT choisi.
 */
export interface IVaultDirectory {
  getAll(): readonly IDocumentMeta[]
  getById(id: string): IDocumentMeta | undefined
  add(doc: IDocumentMeta): void
  remove(id: string): void
  rename(id: string, newPath: string): void
  /** Dossiers explicites (potentiellement vides) - état CRDT, comme les documents. */
  addFolder(path: string): void
  removeFolder(path: string): void
  getFolders(): readonly string[]
  /** État complet encodé - utilisé pour le join initial et pour envoyer à un pair. */
  encodeFullState(): Uint8Array
  /** Applique un update distant (join initial ou diff incrémental). */
  applyUpdate(update: Uint8Array): void
  /** Notifie des updates produits localement - pour les pousser vers les pairs. */
  onLocalUpdate(cb: (update: Uint8Array) => void): () => void
  /** Notifie tout changement de la liste - pour le rendu UI. */
  onChange(cb: () => void): () => void
  dispose(): void
}

/** Port : lecture/écriture de fichiers dans un vault (attachments, notes). */
export interface IVaultStorage {
  readFile(vaultId: string, path: string, token: string): Promise<string>
  writeFile(vaultId: string, path: string, content: string, token: string): Promise<void>
  resolveFileUrl(vaultId: string, path: string): string
  listDocuments(vaultId: string, token: string): Promise<IDocumentMeta[]>
  /** Upload a binary file; returns { fileName (original name), storagePath (GUID-based server path) }. */
  uploadAttachment(vaultId: string, file: File, token: string): Promise<{ fileName: string; storagePath: string }>
}
