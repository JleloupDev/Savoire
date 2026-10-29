// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Pilote SQL abstrait. Le noyau d'indexation ne parle a SQLite que par lui :
//  - pair indexeur : node:sqlite (entree @savoire/indexer-core/node) ;
//  - navigateur : SQLite WebAssembly dans un Worker (messages) ;
//  - bureau : SQLite natif cote Rust (commandes Tauri).
// D'ou une interface ASYNCHRONE, meme quand le pilote ne l'est pas.
//
// Regles pour un pilote :
//  - un seul ecrivain : le noyau serialise lui-meme ses appels ;
//  - `batch` est atomique : une transaction, tout ou rien ;
//  - les valeurs sont des types SQLite (pas de booleen : 0 / 1) ;
//  - les lignes rendues sont des objets simples, nommes par colonne.

/** Une valeur liee a un parametre ou lue dans une colonne. */
export type SqlValue = string | number | null | Uint8Array

/** Une instruction parametree. */
export interface SqlStatement {
  sql: string
  params?: readonly SqlValue[]
}

export type SqlRow = Record<string, SqlValue>

export interface SqlDriver {
  /** Execute un script sans parametre (plusieurs instructions possibles). */
  exec(sql: string): Promise<void>
  /** Les lignes d'une requete. */
  all<T extends object = SqlRow>(sql: string, params?: readonly SqlValue[]): Promise<T[]>
  /** Plusieurs instructions dans UNE transaction : tout ou rien. */
  batch(statements: readonly SqlStatement[]): Promise<void>
  /** Ferme la base. */
  close(): Promise<void>
}

/** Raccourci : une instruction. */
export function sql(text: string, ...params: SqlValue[]): SqlStatement {
  return { sql: text, params }
}
