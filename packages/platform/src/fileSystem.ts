// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Port : le systeme de fichiers d'un vault sur le disque (version bureau).
//
// Un vault sur disque est un dossier ordinaire, comme dans Obsidian : les
// notes en texte clair, les images telles quelles, lisibles et modifiables
// par n'importe quel outil. Ce que le texte ne sait pas porter (etat CRDT
// pour la fusion, identifiants des documents, index) vit dans un dossier
// cache `.savoire/` a la racine du vault.
//
// Toutes les implementations parlent en chemins RELATIFS a la racine du
// vault, separes par « / », jamais en chemins absolus du systeme : la racine
// est fixee a la construction (Tauri, Node pour les tests, memoire).
//
// Le port ne connait ni le CRDT ni le format de `.savoire/` : c'est la
// session de vault sur disque (FileSystemVaultSession) qui les decide.

export interface FileEntry {
  /** Chemin relatif a la racine du vault (« Projet/Note.md »). */
  path: string
  kind: 'file' | 'directory'
  /** Taille en octets (fichiers seulement). */
  size?: number
  /** Derniere modification, en millisecondes depuis l'epoque. */
  mtimeMs?: number
}

/** Un changement vu sur le disque, fait par l'application ou par un autre outil. */
export interface FileChange {
  path: string
  kind: 'created' | 'modified' | 'deleted'
}

export interface IVaultFileSystem {
  /** Racine du vault, telle que l'affiche le systeme (pour l'interface seulement). */
  readonly rootLabel: string

  readText(path: string): Promise<string>
  readBytes(path: string): Promise<Uint8Array>
  /** Ecrit le fichier en entier (cree les dossiers parents). Ecriture atomique si possible. */
  writeText(path: string, content: string): Promise<void>
  writeBytes(path: string, content: Uint8Array): Promise<void>

  exists(path: string): Promise<boolean>
  stat(path: string): Promise<FileEntry | null>
  /** Contenu d'un dossier ('' = la racine). `recursive` descend dans les sous-dossiers. */
  list(dir: string, options?: { recursive?: boolean }): Promise<FileEntry[]>

  mkdir(path: string): Promise<void>
  /** Deplace un fichier ou un dossier (cree les dossiers parents de la cible). */
  rename(from: string, to: string): Promise<void>
  /** Supprime un fichier, ou un dossier et tout son contenu. */
  remove(path: string): Promise<void>

  /**
   * Suit les changements du disque sous la racine, y compris ceux faits par
   * d'autres outils. Optionnel : une implementation qui ne sait pas surveiller
   * le disque ne le fournit pas (la session relit alors a la demande).
   * Rend une fonction d'arret.
   */
  watch?(cb: (changes: FileChange[]) => void): () => void
}
