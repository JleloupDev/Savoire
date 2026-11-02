// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Branchement du pair indexeur dans l'appli web (ADR-027) :
//  - api.search : SearchEngineProvider, avec le plein texte local
//    (FullTextIndexContributor, MiniSearch) en secours ;
//  - api.indexer : IndexerPowersProvider (links, tags, index) ;
//  - api.query : QueryEngineProvider.setPreferred(pair distant) ;
//  - l'etat montre par l'indicateur de la barre du haut.
//
// Le pair vient de la session du vault (IVaultSyncSession.indexer, profil
// serveur). Sans lui, ce module ne touche pas au moteur prefere : un autre
// branchement (index SQLite local du bureau ou du navigateur) peut le poser.
// Il ne retire que ce qu'il a pose lui-meme.
import type { IndexState } from '@savoire/plugin-api'
import {
  FullTextFallbackSearch, IndexerPowersProvider, SearchEngineProvider, indexerSourceOf,
} from '@savoire/application'
import type {
  FullTextIndexLike, GlobalSearchHost, IVaultIndexer, IVaultSyncSession, QueryEngineProvider, VaultIndexerStatus,
} from '@savoire/application'

/** Ce que montre l'indicateur d'index. */
export interface IndexerIndicatorState {
  /** `remote` : pair indexeur ; `local` : index de l'appli (memoire ou SQLite local) ; `none` : pas de vault. */
  source: 'remote' | 'local' | 'none'
  state: IndexState
  /** Pair indexeur seulement. */
  remote?: VaultIndexerStatus
}

export interface IndexerServicesDeps {
  query: QueryEngineProvider
  /** Contributeur plein texte du vault ouvert (registre d'index). */
  fulltext: () => FullTextIndexLike | undefined
  isTrashed?: (docId: string) => boolean
}

export class IndexerServices {
  readonly search = new SearchEngineProvider()
  readonly powers = new IndexerPowersProvider()
  private session: IVaultSyncSession | undefined
  private remote: IVaultIndexer | undefined
  /** Ce module a pose les moteurs preferes et la source des pouvoirs (a retirer au changement de vault). */
  private ownsPreferred = false
  private readonly listeners = new Set<(s: IndexerIndicatorState) => void>()
  private unsubs: (() => void)[] = []
  private host: GlobalSearchHost | null = null

  constructor(private readonly deps: IndexerServicesDeps) {
    this.search.setFallback(new FullTextFallbackSearch({
      index: deps.fulltext,
      pathOf: id => this.session?.directory.getById(id)?.path,
      isTrashed: deps.isTrashed,
    }))
  }

  /** Le pair du vault ouvert (profil serveur), ou rien. */
  get vaultIndexer(): IVaultIndexer | undefined {
    return this.remote
  }

  /** Branche le vault ouvert (apres QueryEngineProvider.attachVault). Undefined : aucun vault. */
  attach(session: IVaultSyncSession | undefined): void {
    for (const u of this.unsubs) u()
    this.unsubs = []
    this.session = session
    const remote = session?.indexer
    this.remote = remote
    const query = this.deps.query
    if (remote) {
      query.setPreferred(remote.query, {
        readYourWrites: true,
        onLocalChange: id => remote.noteLocalChange(id),
      })
      this.ownsPreferred = true
      this.search.setPreferred(remote.search)
      this.search.setGlobalSource(remote)
      this.powers.setSource(indexerSourceOf(remote))
      this.unsubs.push(remote.onStatusChange(() => this.emit()))
    } else {
      // Seulement ce que ce module avait pose : un index local a pu prendre la place.
      if (this.ownsPreferred) {
        query.setPreferred(null)
        this.search.setPreferred(null)
        this.powers.setSource(null)
      }
      this.ownsPreferred = false
      this.search.setGlobalSource(null)
    }
    this.unsubs.push(query.onStateChange(() => this.emit()))
    this.search.setGlobalHost(this.host)
    this.emit()
  }

  /** Noms des vaults et ouverture d'une note d'un autre vault (recherche globale). */
  setGlobalHost(host: GlobalSearchHost | null): void {
    this.host = host
    this.search.setGlobalHost(host)
  }

  indicator(): IndexerIndicatorState {
    if (this.remote) {
      const remote = this.remote.status()
      return { source: 'remote', state: remote.state, remote }
    }
    if (!this.session) return { source: 'none', state: { status: 'ready' } }
    return { source: 'local', state: this.deps.query.state() }
  }

  subscribe(cb: (s: IndexerIndicatorState) => void): () => void {
    this.listeners.add(cb)
    return () => { this.listeners.delete(cb) }
  }

  private emit(): void {
    const s = this.indicator()
    for (const cb of [...this.listeners]) cb(s)
  }
}
