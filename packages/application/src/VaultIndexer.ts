// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Pair indexeur d'un vault, vu de l'appli : capacite d'une session
// (IVaultSyncSession.indexer), comme le partage. Le profil serveur la
// fournit (routes publiques du backend) ; un profil sans pair ne la fournit
// pas, et l'appli garde ses index locaux. Voir ADR-027 et
// docs/Architecture/indexer-protocol.md.
//
// Ce que l'appli en attend :
//  - les moteurs de l'appli (requetes, recherche) et l'appel generique des
//    pouvoirs (links, tags, index) ;
//  - un etat visible : pret, en construction, en retard, indisponible, et
//    pourquoi (pair coupe, surcharge, vault sans pair, pair d'organisation) ;
//  - jamais de rafale : apres un refus (503, 429, reseau), plus aucun appel
//    avant Retry-After ; les requetes suivies se relancent quand l'index
//    avance, pas en boucle.
import type {
  GlobalSearchQuery, IndexState, IndexStatusInfo, IQueryEngine, ISearchEngine, SearchResult,
} from '@savoire/plugin-api'

/** Qui sert le vault : le pair gere par Savoire, celui de l'organisation, ou aucun. */
export type IndexerMode = 'managed' | 'organization' | 'none'

/** Reglage du vault (GET /api/v1/vaults/{id}/indexer). */
export interface VaultIndexerSetting {
  mode: IndexerMode
  /** Adresse du pair d'organisation (mode `organization` seulement). */
  url?: string
  /** Etat de l'index du pair gere ; absent en mode `organization`. */
  state?: IndexStatusInfo
}

export interface VaultIndexerSettingInput {
  mode: IndexerMode
  url?: string
}

/** Pourquoi le pair ne repond pas. */
export type IndexerDownReason =
  /** Pair absent, injoignable ou trop lent (503, reseau, delai). */
  | 'down'
  /** Trop de demandes (429). */
  | 'busy'
  /** Le vault est regle sur « aucun pair ». */
  | 'none'
  /** Le vault est servi par le pair de son organisation : pas encore relie. */
  | 'organization'
  /** Acces refuse (jeton, lien de partage, plus membre). */
  | 'denied'

export interface VaultIndexerStatus {
  /** Etat de l'index, tel que l'appli le voit. */
  state: IndexState
  /** Raison, quand le pair ne repond pas (ou freine). */
  reason?: IndexerDownReason
  /** Reglage connu (rendu avec un 503, ou par le reglage). */
  mode?: IndexerMode
  /** Adresse du pair d'organisation. */
  url?: string
  /** Prochain essai (horloge en ms) tant que le pair ne repond pas. */
  retryAt?: number
  /** Notes modifiees ici que le pair n'a pas encore indexees. */
  pending: number
  /** Derniere sequence vue (index.status). */
  seq?: number
  /** Notes indexees (index.status). */
  docs?: number
}

export interface IVaultIndexer {
  readonly vaultId: string
  /** Requetes (api.query) sur le pair. */
  readonly query: IQueryEngine
  /** Recherche (api.search) sur le pair. */
  readonly search: ISearchEngine
  /**
   * Appel d'un pouvoir (capacite.methode). Rejette avec un QueryErrorInfo :
   * `unavailable` (pair coupe, freine, annule), ou parametres refuses.
   */
  call<T = unknown>(capability: string, method: string, params?: unknown, options?: { signal?: AbortSignal }): Promise<T>
  /** Recherche sur tous les vaults de la personne (POST /api/v1/search). */
  searchAll(query: GlobalSearchQuery, options?: { signal?: AbortSignal }): Promise<SearchResult>
  status(): VaultIndexerStatus
  onStatusChange(cb: (status: VaultIndexerStatus) => void): () => void
  /**
   * Une note a change ici (ou l'arborescence, sans id) : les requetes suivies
   * seront relancees quand le pair l'aura indexee, et la note compte dans
   * `pending` jusque-la.
   */
  noteLocalChange(docId?: string): void
  /** Etat du pair tout de suite, puis requetes suivies relancees. Ignore le delai d'attente. */
  refreshNow(): Promise<void>
  getSetting(): Promise<VaultIndexerSetting>
  /** Proprietaire seulement. Remet les essais a zero. */
  setSetting(setting: VaultIndexerSettingInput): Promise<VaultIndexerSetting>
  dispose(): void
}
