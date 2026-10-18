// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
/**
 * Platform ports - interfaces définies par la couche platform.
 *
 *
 * IDocumentMeta est intentionnellement minimal : la platform ne connaît pas DocumentDto
 * (DTO spécifique à l'API REST). Toute app qui implémente `id` + `path` est compatible.
 */
import type { DocumentRoomPresence } from '@savoire/plugin-api'

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

// ── Contenu du vault, servi par la session de synchro ────────────────────────
//
// Deux familles de documents, jamais melangees :
//
//  'crdt'     — l'etat EST un CRDT (le markdown : un Y.Text). Plusieurs
//               redacteurs convergent.
//  'snapshot' — l'etat est un texte complet, en dernier-ecrivain-gagne
//               (Excalidraw, mindmap, table, texte brut). Le verrou d'edition
//               evite que deux redacteurs s'ecrasent.
//
// Le jour ou un type devient un vrai CRDT, il change de famille ; le reste ne
// bouge pas. Un connecteur P2P fournit les deux familles comme le serveur.

export type DocumentSyncKind = 'crdt' | 'snapshot'

/**
 * Famille de synchro par defaut, d'apres le chemin : seul le Markdown est un
 * CRDT. L'application fournit mieux quand elle connait les types declares par
 * les plugins (un type 'crdt' est un CRDT, quelle que soit son extension).
 */
export function documentSyncKind(path: string): DocumentSyncKind {
  return path.endsWith('.md') ? 'crdt' : 'snapshot'
}

/** Document « sans CRDT » : un texte complet, en dernier-ecrivain-gagne. */
export interface ISnapshotDocument {
  /** Dernier contenu connu, une fois l'etat initial recu. null = jamais ecrit. */
  load(): Promise<string | null>
  /** Remplace le contenu : diffuse aux autres pairs (et persiste si le profil le fait). */
  write(content: string): Promise<void>
  /** Un autre pair a ecrit. Jamais appele pour nos propres ecritures. */
  onRemoteWrite(cb: (content: string, fromUserId: string) => void): () => void
  /** Presence ephemere (curseur, avatar). Jamais persistee. */
  updatePresence(presence: DocumentRoomPresence): Promise<void>
  onPresence(cb: (userId: string, presence: DocumentRoomPresence) => void): () => void
}

/**
 * Fichiers binaires du vault (pieces jointes : images, PDF).
 *
 * Un fichier est range sous un IDENTIFIANT, celui de son document dans le
 * repertoire. Son nom affiche (`attachments/Mon image.png`) vit dans le
 * repertoire, pas ici : il reste libre, lisible et renommable sans toucher
 * aux octets. Le nommage, l'insertion et la taille sont l'affaire de
 * l'application ; le port ne fait que stocker et rendre.
 *
 * Anciennes pieces jointes : rangees sous leur nom de stockage
 * (`<guid>.png`). `url` et `read` acceptent aussi ce nom.
 */
/** Options d'un envoi de fichier. */
export interface FileUploadOptions {
  /** Progression 0..1, quand le transport sait la mesurer (envoi HTTP). */
  onProgress?(fraction: number): void
}

/**
 * Rangement d'une piece jointe, annonce au gardien du vault : la note dont
 * le dossier la contient (null : rangee ailleurs) et son nom affiche. Sert
 * au partage d'une note (le serveur ne lit pas les chemins).
 */
export interface AttachmentPlacement {
  noteId: string | null
  name: string
}

export interface IVaultFiles {
  /** Stocke (ou remplace) le fichier sous `fileId`, et le rend lisible aux autres pairs. */
  upload(fileId: string, file: Blob, options?: FileUploadOptions): Promise<void>
  /**
   * Annonce le rangement d'une piece jointe. Absent : rien a annoncer (pair a
   * pair, ou le partage par lien n'existe pas).
   */
  place?(fileId: string, placement: AttachmentPlacement): Promise<void>
  /**
   * URL affichable (balise <img>), apres une lecture autorisee : une URL
   * blob: le plus souvent. Rejette si le fichier est introuvable.
   */
  url(fileId: string): Promise<string>
  /** Contenu texte du fichier. Rejette s'il est introuvable. */
  read(fileId: string): Promise<string>
  /** Octets du fichier, tels quels, et leur type MIME. Rejette s'il est introuvable. */
  readBytes(fileId: string): Promise<{ bytes: Uint8Array; type: string }>
}

/**
 * Le contenu du vault vu par la plateforme : ce que VaultClient demande a la
 * session. Sous-ensemble de IVaultSyncSession (@savoire/application), declare
 * ici parce que la plateforme ne depend pas de la couche application.
 */
export interface IVaultContentSession {
  /** Lecture ponctuelle (embeds, vault.read) sans garder de synchro ouverte. */
  readDocument(docId: string, kind: DocumentSyncKind): Promise<string>
  /** Ouvre (ou reprend) un document snapshot. Compte les ouvertures. */
  openSnapshot(docId: string): ISnapshotDocument
  /** Rend une ouverture ; la synchro s'arrete quand il n'en reste aucune. */
  closeSnapshot(docId: string): void
  readonly files: IVaultFiles
  /**
   * Fait connaitre des documents au(x) gardien(s) du vault avant de les
   * creer. En mode serveur, le serveur tient un registre « document -> vault »
   * et refuse tout document qui n'y est pas inscrit dans le vault annonce :
   * creer un document commence donc par la. Sans serveur, rien a faire.
   * Echoue si l'inscription est refusee (droits, document d'un autre vault).
   */
  registerDocuments(docIds: string[]): Promise<void>
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
