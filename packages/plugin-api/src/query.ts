// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// ─── Moteur de requetes ───────────────────────────────────────────────────
//
// Les requetes de l'appli (recherche, bases, graphe, liens, proprietes)
// passent par ce contrat, quel que soit l'endroit ou elles s'executent :
// index SQLite du bureau, SQLite WebAssembly du navigateur, ou pair
// indexeur (gere par Savoire ou par l'organisation). Voir ADR-027.
//
// La requete est DECLARATIVE : jamais de SQL venant d'un client ou d'un
// plugin. Chaque realisation la traduit (SQL parametre pour SQLite) et
// applique les memes regles, verifiees par une suite de contrat commune.
//
// Regles communes :
//  - une valeur absente (propriete non renseignee, null, '', []) est « vide » ;
//    elle ne satisfait aucune comparaison, et se trie EN DERNIER quel que
//    soit le sens ;
//  - les comparaisons de texte ignorent la casse et les accents ;
//  - sur une liste (multiselect), eq / contains = « contient cette valeur »,
//    in = « contient au moins une de ces valeurs » ;
//  - les dates se comparent comme des chaines ISO 8601 ;
//  - a tri egal, l'ordre est celui de l'id : la pagination est stable.

import type { PropertyValue } from './properties'

/** Champ d'une note ou d'une ligne : une propriete, ou un champ du document. */
export type QueryField =
  | { prop: string }
  | { doc: 'path' | 'title' | 'folder' | 'ext' | 'created' | 'modified' }

export type FilterOp =
  | 'eq' | 'neq'
  | 'lt' | 'lte' | 'gt' | 'gte'
  | 'contains' | 'startsWith'
  | 'in'
  | 'empty' | 'notEmpty'

export type QueryFilter =
  | { and: QueryFilter[] }
  | { or: QueryFilter[] }
  | { not: QueryFilter }
  | { field: QueryField; op: FilterOp; value?: PropertyValue }

export interface QuerySort {
  field: QueryField
  dir?: 'asc' | 'desc'
}

/** D'ou viennent les resultats. */
export type QuerySource =
  /** Les notes du vault (corbeille exclue), eventuellement d'un dossier et de certaines extensions. */
  | { notes: true; folder?: string; ext?: string[] }

export interface Query {
  from: QuerySource
  where?: QueryFilter
  /** Recherche plein texte : tous les mots doivent apparaitre (prefixes acceptes). */
  text?: string
  sort?: QuerySort[]
  /** Proprietes a renvoyer dans `values` ; toutes si absent. */
  select?: string[]
  /** Comptes par valeur d'un champ, sur tout le resultat (pas seulement la page) ;
   *  les plus nombreux d'abord, les vides sous la cle null. */
  groupBy?: QueryField
  /** Taille de page : QUERY_DEFAULT_LIMIT par defaut, QUERY_MAX_LIMIT au plus. */
  limit?: number
  /** Suite d'une page precedente (`QueryResult.next`), pour la MEME requete. */
  cursor?: string
}

export const QUERY_DEFAULT_LIMIT = 50
export const QUERY_MAX_LIMIT = 500

export interface QueryRow {
  /** Id du document. */
  id: string
  path: string
  title: string
  values: Record<string, PropertyValue>
}

export interface QueryGroup {
  key: PropertyValue
  count: number
}

/** Etat de l'index qui a repondu : l'appli l'affiche (« index en construction, 63 % »). */
export interface IndexState {
  status: 'ready' | 'building' | 'lagging' | 'unavailable'
  /** Construction : de 0 a 1. */
  progress?: number
  /** Retard sur les modifications, en millisecondes. */
  lagMs?: number
}

export interface QueryResult {
  rows: QueryRow[]
  /** Curseur de la page suivante ; absent a la derniere page. */
  next?: string
  /** Nombre total de resultats. */
  total: number
  groups?: QueryGroup[]
  index: IndexState
}

/** Requete refusee : champ inconnu, limite depassee, curseur d'une autre requete... */
export interface QueryErrorInfo {
  code: 'invalid_query' | 'invalid_cursor' | 'too_complex' | 'unavailable'
  message: string
}

export interface IQueryEngine {
  /** Execute la requete. Rejette avec un QueryErrorInfo (champ `code`) si elle est refusee. */
  query(query: Query, options?: { signal?: AbortSignal }): Promise<QueryResult>
  /** Resultat a jour a chaque changement de l'index qui le concerne. Rend une fonction d'arret. */
  watch(query: Query, cb: (result: QueryResult) => void): () => void
  state(): IndexState
  onStateChange(cb: (state: IndexState) => void): () => void
}
