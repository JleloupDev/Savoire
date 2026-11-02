// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// ─── Pouvoirs de l'index ──────────────────────────────────────────────────
//
// Ce que sait un index de TOUT le vault (pair indexeur, ou index local
// complet), au-dela des requetes (query.ts) et de la recherche (search.ts) :
// liens, tags, etat. Un plugin s'en sert quand il est disponible, et garde
// son comportement local sinon (notes ouvertes seulement). Voir ADR-027 et
// docs/Architecture/indexer-protocol.md (« Pouvoirs et methodes »).
//
// Regles :
//  - `available()` faux : aucun index complet ne sert ce vault (profil sans
//    pair ni index local, pair coupe, vault regle sur « aucun ») ;
//  - un appel peut rejeter avec un QueryErrorInfo : `unavailable` (pair
//    coupe, delai depasse, appel annule) -> comportement local ; les autres
//    codes : parametres refuses ;
//  - les ids sont ceux des documents (VaultAPI.resolveDocumentId) ;
//  - la corbeille (.trash/) n'apparait jamais.

import type { IndexState } from './query'

export interface IndexerCallOptions {
  signal?: AbortSignal
}

/** Une note reperee par l'index. */
export interface IndexedNoteRef {
  id: string
  path: string
  title: string
}

export interface BacklinkItem extends IndexedNoteRef {
  /** Nombre de liens de cette note vers la cible. */
  count: number
}

export interface UnresolvedLinkItem {
  /** La cible telle qu'elle est ecrite. */
  target: string
  count: number
  /** Notes qui la citent (50 au plus). */
  sources: string[]
}

export interface IndexGraph {
  nodes: IndexedNoteRef[]
  edges: { from: string; to: string }[]
}

export interface TagCount {
  tag: string
  /** Nombre de notes. */
  count: number
}

/** Etat detaille de l'index (methode index.status). */
export interface IndexStatusInfo extends IndexState {
  /** Derniere sequence de changements traitee. */
  seq?: number
  /** Notes indexees. */
  docs?: number
  /** Taille de l'index, en octets. */
  bytes?: number
}

export interface IIndexerLinks {
  /** Notes qui pointent vers `id` (sans elle-meme), par chemin. */
  backlinks(params: { id: string; limit?: number }, options?: IndexerCallOptions): Promise<{ items: BacklinkItem[] }>
  /** Liens d'une note, dans l'ordre du texte. */
  outgoing(params: { id: string }, options?: IndexerCallOptions): Promise<{ resolved: IndexedNoteRef[]; unresolved: { target: string }[] }>
  /** Liens vers des notes qui n'existent pas, les plus nombreux d'abord. */
  unresolved(params?: { limit?: number }, options?: IndexerCallOptions): Promise<{ items: UnresolvedLinkItem[] }>
  /** Graphe des notes ; au-dela de `limit`, les plus reliees d'abord. */
  graph(params?: { folder?: string; limit?: number }, options?: IndexerCallOptions): Promise<IndexGraph>
}

export interface IIndexerTags {
  /** Tags du vault ; `prefix` : ce tag et ses sous-tags. Casse ignoree. */
  list(params?: { prefix?: string; limit?: number }, options?: IndexerCallOptions): Promise<{ items: TagCount[] }>
  /** Notes d'un tag, sous-tags compris (`a` donne aussi `a/b`). */
  notes(params: { tag: string; limit?: number }, options?: IndexerCallOptions): Promise<{ items: IndexedNoteRef[] }>
}

export interface IIndexerAPI {
  /** Vrai si un index de tout le vault repond en ce moment. */
  available(): boolean
  /** Etat de cet index ; `unavailable` quand available() est faux. */
  state(): IndexState
  /** Disponibilite ou etat change (vault ouvert, pair coupe ou revenu, construction). */
  onStateChange(cb: (state: IndexState) => void): () => void
  readonly links: IIndexerLinks
  readonly tags: IIndexerTags
  /** Etat detaille (sequence, nombre de notes, taille). */
  status(options?: IndexerCallOptions): Promise<IndexStatusInfo>
}
