// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Fournisseur des pouvoirs de l'index (liens, tags, etat) : c'est lui que les
// plugins recoivent en `api.indexer`. Voir ADR-027 et plugin-api/indexer.ts.
//
// Objet stable pour toute la session ; sa source change avec le vault ouvert :
// le pair indexeur (profil serveur), un index SQLite local complet, ou rien.
// Sans source, ou source qui ne repond pas, available() est faux et les
// appels rejettent avec `unavailable` : le plugin garde son comportement local.
import type {
  IIndexerAPI, IIndexerLinks, IIndexerTags, IndexerCallOptions, IndexState, IndexStatusInfo, QueryErrorInfo,
} from '@savoire/plugin-api'
import type { IVaultIndexer } from './VaultIndexer'

/** Ce qui sert les pouvoirs : appel du protocole et etat (VaultIndex de indexer-core, pair distant). */
export interface IIndexerSource {
  call(capability: string, method: string, params?: unknown, options?: { signal?: AbortSignal }): Promise<unknown>
  state(): IndexState
  onStateChange(cb: (state: IndexState) => void): () => void
}

/** Le pair indexeur d'un vault, comme source de pouvoirs. */
export function indexerSourceOf(indexer: IVaultIndexer): IIndexerSource {
  return {
    call: (capability, method, params, options) => indexer.call(capability, method, params, options),
    state: () => indexer.query.state(),
    onStateChange: cb => indexer.query.onStateChange(cb),
  }
}

class PowerUnavailable extends Error implements QueryErrorInfo {
  readonly code = 'unavailable' as const
  constructor(message: string) {
    super(message)
  }
}

const UNAVAILABLE: IndexState = { status: 'unavailable' }

export class IndexerPowersProvider implements IIndexerAPI {
  private source: IIndexerSource | null = null
  private unsub: (() => void) | null = null
  private readonly listeners = new Set<(s: IndexState) => void>()
  private last = JSON.stringify(UNAVAILABLE)

  readonly links: IIndexerLinks = {
    backlinks: (params, options) => this.call('links', 'backlinks', params, options),
    outgoing: (params, options) => this.call('links', 'outgoing', params, options),
    unresolved: (params, options) => this.call('links', 'unresolved', params ?? {}, options),
    graph: (params, options) => this.call('links', 'graph', params ?? {}, options),
  }

  readonly tags: IIndexerTags = {
    list: (params, options) => this.call('tags', 'list', params ?? {}, options),
    notes: (params, options) => this.call('tags', 'notes', params, options),
  }

  /** Nouvelle source (vault ouvert) ; null : aucune. */
  setSource(source: IIndexerSource | null): void {
    this.unsub?.()
    this.unsub = null
    this.source = source
    if (source) this.unsub = source.onStateChange(() => this.emit())
    this.emit(true)
  }

  available(): boolean {
    return this.state().status !== 'unavailable'
  }

  state(): IndexState {
    return this.source?.state() ?? UNAVAILABLE
  }

  onStateChange(cb: (state: IndexState) => void): () => void {
    this.listeners.add(cb)
    return () => { this.listeners.delete(cb) }
  }

  status(options?: IndexerCallOptions): Promise<IndexStatusInfo> {
    return this.call('index', 'status', {}, options)
  }

  dispose(): void {
    this.unsub?.()
    this.unsub = null
    this.source = null
    this.listeners.clear()
  }

  private call<T>(capability: string, method: string, params: unknown, options?: IndexerCallOptions): Promise<T> {
    const source = this.source
    if (!source) return Promise.reject(new PowerUnavailable('Aucun index complet pour ce vault.'))
    return source.call(capability, method, params, options) as Promise<T>
  }

  /** Previent les abonnes si l'etat change (ou toujours : la source a change). */
  private emit(always = false): void {
    const s = this.state()
    const sig = JSON.stringify(s)
    if (!always && sig === this.last) return
    this.last = sig
    for (const cb of [...this.listeners]) cb(s)
  }
}
