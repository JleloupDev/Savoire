// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// ─── Recherche plein texte ────────────────────────────────────────────────
//
// La recherche de l'appli (panneau de recherche, palette, recherche globale
// sur tous les vaults) passe par ce contrat, quel que soit l'endroit ou elle
// s'execute : index SQLite du bureau, SQLite WebAssembly du navigateur, ou
// pair indexeur. Voir ADR-027 et docs/Architecture/indexer-protocol.md.
//
// Regles communes :
//  - le texte cherche est decoupe en mots ; une note doit contenir TOUS les
//    mots (titre, texte, proprietes texte) ; chaque mot vaut aussi comme
//    debut de mot (« electri » trouve « electricite ») ;
//  - "entre guillemets" : la suite de mots exacte ;
//  - casse et accents ignores ;
//  - la corbeille (.trash/) n'est jamais cherchee ;
//  - les plus pertinents d'abord (un mot du titre compte plus qu'un mot du
//    texte), a egalite l'ordre de l'id : la pagination est stable.

import type { IndexState, QueryFilter } from './query'

export interface SearchQuery {
  /** Ce que la personne a tape. Vide : aucun resultat. */
  text: string
  /** Seulement ce dossier (et ses sous-dossiers). */
  folder?: string
  /** Seulement ces extensions (sans le point). */
  ext?: string[]
  /** Filtre sur les proprietes, meme langage que Query.where. */
  where?: QueryFilter
  /** Taille de page : QUERY_DEFAULT_LIMIT par defaut, QUERY_MAX_LIMIT au plus. */
  limit?: number
  /** Suite d'une page precedente (`SearchResult.next`), pour la MEME recherche. */
  cursor?: string
}

/** Portion trouvee, en positions dans le texte qui la porte (debut inclus, fin exclue). */
export interface SearchHighlight {
  start: number
  end: number
}

/** Un extrait de la note autour des mots trouves. */
export interface SearchSnippet {
  /** Texte brut de l'extrait (sans Markdown), « … » aux coupures. */
  text: string
  highlights: SearchHighlight[]
  /** Titre de section le plus proche au-dessus de l'extrait, s'il y en a un. */
  heading?: string
}

export interface SearchHit {
  /** Id du document. */
  id: string
  path: string
  title: string
  /** Plus grand = plus pertinent. Comparable seulement dans une meme reponse. */
  score: number
  /** Mots trouves dans le titre. */
  titleHighlights?: SearchHighlight[]
  /** Quelques extraits (3 au plus), dans l'ordre du texte. */
  snippets: SearchSnippet[]
  /** Recherche globale (plusieurs vaults) : le vault de la note. */
  vaultId?: string
}

export interface SearchResult {
  hits: SearchHit[]
  /** Curseur de la page suivante ; absent a la derniere page. */
  next?: string
  /** Nombre total de notes trouvees. */
  total: number
  /** Etat de l'index qui a repondu (le moins avance, pour une recherche globale). */
  index: IndexState
  /** Vrai si une partie des vaults n'a pas pu repondre (recherche globale). */
  partial?: boolean
}

export interface ISearchEngine {
  /** Rejette avec un QueryErrorInfo (champ `code`) si la recherche est refusee. */
  search(query: SearchQuery, options?: { signal?: AbortSignal }): Promise<SearchResult>
  state(): IndexState
  onStateChange(cb: (state: IndexState) => void): () => void
}
