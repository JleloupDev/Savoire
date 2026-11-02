// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Fournisseur de la recherche de l'appli : c'est lui que les plugins
// recoivent en `api.search`. Voir ADR-027 et search.ts.
//
// Deux moteurs, comme pour les requetes (QueryEngineProvider) :
//  - le moteur prefere, qui connait tout le vault : pair indexeur (profil
//    serveur) ou index SQLite local ; il repond d'abord ;
//  - le secours, quand il manque ou ne repond pas (`unavailable`) : le plein
//    texte local (MiniSearch, notes ouvertes seulement). L'etat est alors
//    `unavailable` : la recherche est limitee, et l'appli le dit.
// La recherche sur tous les vaults (`global`) n'existe que si le vault ouvert
// en a la source (pair indexeur) et que l'appli sait ouvrir un autre vault.
import type {
  GlobalSearchQuery, IGlobalSearch, IndexState, ISearchEngine, QueryErrorInfo, SearchQuery, SearchResult,
} from '@savoire/plugin-api'

/** Ce que l'appli fournit a la recherche globale. */
export interface GlobalSearchHost {
  /** Nom d'un vault de la personne, s'il est connu. */
  vaultName(vaultId: string): string | undefined
  /** Ouvre une note : dans le vault ouvert, ou apres avoir ouvert son vault. */
  open(vaultId: string | undefined, path: string): Promise<void>
}

/** D'ou vient la recherche globale (IVaultIndexer.searchAll). */
export interface GlobalSearchSource {
  searchAll(query: GlobalSearchQuery, options?: { signal?: AbortSignal }): Promise<SearchResult>
}

class SearchUnavailable extends Error implements QueryErrorInfo {
  readonly code = 'unavailable' as const
  constructor(message: string) {
    super(message)
  }
}

function codeOf(err: unknown): string | undefined {
  return (err as { code?: string } | null)?.code
}

export class SearchEngineProvider implements ISearchEngine {
  private preferred: ISearchEngine | null = null
  private fallback: ISearchEngine | null = null
  private source: GlobalSearchSource | null = null
  private host: GlobalSearchHost | null = null
  private unsubPreferred: (() => void) | null = null
  private readonly listeners = new Set<(s: IndexState) => void>()
  private last = ''

  /** Moteur prefere (pair indexeur, SQLite local) ; null : le secours seul. */
  setPreferred(engine: ISearchEngine | null): void {
    this.unsubPreferred?.()
    this.unsubPreferred = null
    this.preferred = engine
    if (engine) this.unsubPreferred = engine.onStateChange(() => this.emit())
    this.emit()
  }

  /** Secours (plein texte local) ; null : aucun. */
  setFallback(engine: ISearchEngine | null): void {
    this.fallback = engine
    this.emit()
  }

  /** Source de la recherche globale ; null : pas de recherche globale. */
  setGlobalSource(source: GlobalSearchSource | null): void {
    this.source = source
    this.emit(true)
  }

  setGlobalHost(host: GlobalSearchHost | null): void {
    this.host = host
    this.emit(true)
  }

  dispose(): void {
    this.unsubPreferred?.()
    this.unsubPreferred = null
    this.listeners.clear()
  }

  // ── ISearchEngine ────────────────────────────────────────────────────────

  async search(query: SearchQuery, options?: { signal?: AbortSignal }): Promise<SearchResult> {
    const p = this.preferred
    if (p && p.state().status !== 'unavailable') {
      try {
        return await p.search(query, options)
      } catch (err) {
        if (codeOf(err) !== 'unavailable' || options?.signal?.aborted) throw err
      }
    }
    const f = this.fallback
    if (!f) throw new SearchUnavailable('Aucun index de recherche pour ce vault.')
    return f.search(query, options)
  }

  /**
   * Etat du moteur qui repond. `unavailable` : pas de moteur complet, ou il
   * ne repond pas ; la recherche se limite alors au secours.
   */
  state(): IndexState {
    const p = this.preferred
    if (p) {
      const s = p.state()
      if (s.status !== 'unavailable') return s
    }
    return { status: 'unavailable' }
  }

  onStateChange(cb: (state: IndexState) => void): () => void {
    this.listeners.add(cb)
    return () => { this.listeners.delete(cb) }
  }

  get global(): IGlobalSearch | undefined {
    const source = this.source
    const host = this.host
    if (!source || !host) return undefined
    return {
      search: async (query, options) => {
        const r = await source.searchAll(query, options)
        return {
          ...r,
          hits: r.hits.map(h => {
            const name = h.vaultId ? host.vaultName(h.vaultId) : undefined
            return name ? { ...h, vaultName: name } : h
          }),
        }
      },
      open: hit => host.open(hit.vaultId, hit.path),
    }
  }

  // ── Interne ──────────────────────────────────────────────────────────────

  /** Previent les abonnes quand l'etat change (ou toujours : la recherche globale a change). */
  private emit(always = false): void {
    const s = this.state()
    const sig = JSON.stringify(s)
    if (!always && sig === this.last) return
    this.last = sig
    for (const cb of [...this.listeners]) cb(s)
  }
}
