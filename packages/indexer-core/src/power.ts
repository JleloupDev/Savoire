// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Un POUVOIR (capacite) de l'index : ses tables, ce qu'il tire d'une note,
// ses methodes. L'index (VaultIndex) n'en connait aucun en particulier :
// ajouter un pouvoir = ajouter un module qui suit ce contrat et l'inscrire
// dans la liste des pouvoirs. Voir ADR-027 et indexer-protocol.md.
//
// Ordre des ecritures d'une note, dans UNE transaction :
//   remove(ancienne version) de chaque pouvoir -> ligne de `docs` -> write()
// Suppression : remove() -> ligne de `docs` effacee -> afterRemove().
// Deplacement sans changement de contenu : ligne de `docs` -> move().
//
// Un pouvoir ne recoit jamais de SQL de l'exterieur : ses methodes valident
// leurs parametres (parse) puis composent du SQL parametre.
import type { IndexState } from '@savoire/plugin-api'
import type { SqlDriver, SqlStatement } from './driver'
import type { NoteRecord } from './extract/note'

/** Un document tel que l'index le range. `n` : sa cle interne (ligne de `docs`). */
export interface DocRef {
  n: number
  id: string
  path: string
  base?: string | null
}

export interface PowerContext {
  readonly driver: SqlDriver
  /** Ce qu'un autre pouvoir offre (filtres, plein texte...), s'il est inscrit. */
  api<T>(power: string): T | undefined
  /** Etat de l'index, rendu avec les resultats. */
  state(): IndexState
}

export interface MethodOptions {
  signal?: AbortSignal
}

export interface PowerMethod<P = unknown, R = unknown> {
  /** Verifie les parametres (JSON venu du reseau). Leve IndexError('invalid_query'...). */
  parse(params: unknown): P
  run(ctx: PowerContext, params: P, options: MethodOptions): Promise<R>
}

export type Statements = SqlStatement[] | Promise<SqlStatement[]>

export interface IndexPower {
  /** Nom stable : la capacite du protocole (`query`, `search`, `links`...). */
  readonly name: string
  /** Version du schema du pouvoir : la changer vide ses tables et demande une reconstruction. */
  readonly version: number
  /** Tables (et tables virtuelles) du pouvoir : supprimees quand sa version change. */
  readonly tables?: readonly string[]
  /** Instructions de creation (CREATE ... IF NOT EXISTS). */
  readonly schema?: readonly string[]
  /** Ecrit ce que le pouvoir tire de la note. Le document est deja dans `docs`. */
  write?(ctx: PowerContext, doc: DocRef, note: NoteRecord): Statements
  /** Efface ce que le pouvoir garde du document (avant sa nouvelle version, ou sa suppression). */
  remove?(ctx: PowerContext, doc: DocRef): Statements
  /** Apres la suppression de la ligne de `docs` (liens a resoudre a nouveau...). */
  afterRemove?(ctx: PowerContext, doc: DocRef): Statements
  /** Le document a change de chemin (et de titre s'il venait du nom) ; contenu inchange. */
  move?(ctx: PowerContext, doc: DocRef, from: { path: string; title: string }, to: { path: string; title: string }): Statements
  /**
   * Donnees qui ne viennent pas d'une note (texte des pieces jointes,
   * vecteurs calcules ailleurs...) : point d'entree des pouvoirs a venir.
   * Appele par VaultIndex.ingest(pouvoir, donnees), dans une transaction.
   */
  ingest?(ctx: PowerContext, input: unknown): Statements
  /** Methodes appelables : `capacite.methode` dans le protocole. */
  readonly methods?: Readonly<Record<string, PowerMethod<any, any>>> // eslint-disable-line @typescript-eslint/no-explicit-any
  /** Ce que le pouvoir offre aux autres pouvoirs (ctx.api(nom)). */
  readonly api?: unknown
}

/** Aide a declarer une methode typee. */
export function method<P, R>(m: PowerMethod<P, R>): PowerMethod<P, R> {
  return m
}
