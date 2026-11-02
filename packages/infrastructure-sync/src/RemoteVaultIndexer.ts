// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Le pair indexeur d'un vault, par les routes publiques du backend (profil
// serveur). Voir ADR-027, docs/Architecture/indexer-protocol.md et
// application/VaultIndexer.ts.
//
// Trois regles :
//  - jamais de rafale. Apres un refus (503, 429, reseau, delai), plus aucun
//    appel avant l'echeance : Retry-After, ou une attente qui double (5 s,
//    10 s... 60 s au plus). Pendant ce temps, les appels rejettent tout de
//    suite avec `unavailable` : l'appli bascule sur ses index locaux ;
//  - un seul minuteur lit l'etat du pair (index.status) : au demarrage,
//    a l'echeance d'un refus, peu apres une modification locale, puis a
//    intervalle large tant que quelqu'un suit (30 s ; 5 s en construction) ;
//  - les requetes suivies (watch) ne se relancent que si l'index a avance
//    (sequence), s'il revient, ou s'il se construit : une requete en cours
//    plus une en attente au plus, par requete.
import type {
  GlobalSearchQuery, IndexState, IndexStatusInfo, IQueryEngine, ISearchEngine, Query, QueryErrorInfo,
  QueryResult, SearchQuery, SearchResult,
} from '@savoire/plugin-api'
import type {
  IndexerDownReason, IndexerMode, IVaultIndexer, VaultIndexerSetting, VaultIndexerSettingInput, VaultIndexerStatus,
} from '@savoire/application'
import { IndexerHttpClient, IndexerHttpError } from './IndexerHttpClient'
import type { IndexerHttpClientOptions } from './IndexerHttpClient'

export interface RemoteVaultIndexerOptions {
  /** Horloge et minuteurs (tests). */
  now?: () => number
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
  /** Etat du pair relu a cet intervalle tant que quelqu'un suit. Defaut : 30 s. */
  idlePollMs?: number
  /** Index en construction ou en retard : relu plus souvent. Defaut : 5 s. */
  busyPollMs?: number
  /** Apres une modification locale, premier coup d'oeil. Defaut : 1,5 s (le pair regroupe 1 s). */
  settleMs?: number
  /** Ecart minimal entre deux lectures de l'etat. Defaut : 2 s. */
  minCheckMs?: number
  /** Une note modifiee ici quitte `pending` au plus tard apres ce delai. Defaut : 20 s. */
  pendingTtlMs?: number
  /** Attente apres un echec : la premiere, doublee ensuite jusqu'au plafond. Defaut : 5 s, 60 s. */
  retryBaseMs?: number
  retryMaxMs?: number
  /** Vault sans pair, pair d'organisation, acces refuse : nouvel essai apres. Defaut : 60 s. */
  modeRetryMs?: number
}

/** Rejet d'un moteur distant : la forme QueryErrorInfo du contrat. */
export class RemoteIndexError extends Error implements QueryErrorInfo {
  constructor(readonly code: QueryErrorInfo['code'], message: string) {
    super(message)
    this.name = 'RemoteIndexError'
  }
}

const QUERY_CODES = new Set(['invalid_query', 'invalid_cursor', 'too_complex'])

interface RemoteWatch {
  query: Query
  cb: (r: QueryResult) => void
  running: boolean
  again: boolean
  stopped: boolean
  /** Fin de la serie de relances en cours. */
  done?: Promise<void>
}

interface CallOptions {
  signal?: AbortSignal
  /** Ignore l'attente apres un refus (bouton « reessayer »). */
  force?: boolean
}

function sameStatus(a: VaultIndexerStatus, b: VaultIndexerStatus): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

export class RemoteVaultIndexer implements IVaultIndexer {
  readonly query: IQueryEngine
  readonly search: ISearchEngine

  private readonly now: () => number
  private readonly setTimer: (fn: () => void, ms: number) => unknown
  private readonly clearTimer: (handle: unknown) => void
  private readonly o: Required<Omit<RemoteVaultIndexerOptions, 'now' | 'setTimer' | 'clearTimer'>>

  private st: VaultIndexerStatus = { state: { status: 'ready' }, pending: 0 }
  private readonly statusListeners = new Set<(s: VaultIndexerStatus) => void>()
  private readonly watches = new Set<RemoteWatch>()
  /** Pas d'appel avant (horloge en ms). */
  private blockedUntil = 0
  private failures = 0
  /**
   * Notes modifiees ici (cle '' : l'arborescence) -> moment de la derniere
   * modification et sequence du pair a ce moment.
   */
  private readonly pending = new Map<string, { at: number; seq?: number; idle?: boolean }>()
  /** Modification locale pas encore vue par le pair (sans note precise comprise). */
  private dirtyAt: number | null = null
  private dirtyChecks = 0
  private lastCheck = Number.NEGATIVE_INFINITY
  private probe = true
  private timer: unknown = null
  private checking: Promise<void> | null = null
  private disposed = false

  constructor(
    readonly vaultId: string,
    private readonly http: IndexerHttpClient,
    options: RemoteVaultIndexerOptions = {},
  ) {
    this.now = options.now ?? (() => Date.now())
    this.setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
    this.clearTimer = options.clearTimer ?? (h => clearTimeout(h as ReturnType<typeof setTimeout>))
    this.o = {
      idlePollMs: options.idlePollMs ?? 30_000,
      busyPollMs: options.busyPollMs ?? 5_000,
      settleMs: options.settleMs ?? 1_500,
      minCheckMs: options.minCheckMs ?? 2_000,
      pendingTtlMs: options.pendingTtlMs ?? 20_000,
      retryBaseMs: options.retryBaseMs ?? 5_000,
      retryMaxMs: options.retryMaxMs ?? 60_000,
      modeRetryMs: options.modeRetryMs ?? 60_000,
    }
    this.query = {
      query: (q, opts) => this.call<QueryResult>('query', 'run', q, opts),
      watch: (q, cb) => this.watch(q, cb),
      state: () => this.st.state,
      onStateChange: cb => this.onIndexStateChange(cb),
    }
    this.search = {
      search: (q: SearchQuery, opts) => this.call<SearchResult>('search', 'run', q, opts),
      state: () => this.st.state,
      onStateChange: cb => this.onIndexStateChange(cb),
    }
    // Premier coup d'oeil : l'etat du pair et le reglage du vault, des l'ouverture.
    this.schedule()
  }

  /** Construit le client HTTP et le pair d'un vault. */
  static create(vaultId: string, http: IndexerHttpClientOptions, options?: RemoteVaultIndexerOptions): RemoteVaultIndexer {
    return new RemoteVaultIndexer(vaultId, new IndexerHttpClient(http), options)
  }

  // ── Appels ───────────────────────────────────────────────────────────────

  call<T = unknown>(capability: string, method: string, params?: unknown, options: CallOptions = {}): Promise<T> {
    if (this.disposed) return Promise.reject(new RemoteIndexError('unavailable', 'Vault ferme.'))
    if (options.signal?.aborted) return Promise.reject(new RemoteIndexError('unavailable', 'Requete annulee.'))
    if (!options.force && this.now() < this.blockedUntil) {
      return Promise.reject(new RemoteIndexError('unavailable', this.blockedMessage()))
    }
    // Pas d'attente avant l'envoi : l'ordre des appels est celui des envois.
    return this.http.call<unknown>(this.vaultId, capability, method, params ?? {}, options.signal).then(
      result => {
        this.succeeded(stateOf(result))
        return result as T
      },
      err => { throw this.failed(err) },
    )
  }

  async searchAll(query: GlobalSearchQuery, options: { signal?: AbortSignal } = {}): Promise<SearchResult> {
    if (options.signal?.aborted) throw new RemoteIndexError('unavailable', 'Recherche annulee.')
    try {
      return await this.http.searchAll(query, options.signal)
    } catch (err) {
      // Route globale : ses refus ne disent rien du pair de ce vault.
      throw toQueryError(err)
    }
  }

  // ── Requetes suivies ─────────────────────────────────────────────────────

  private watch(query: Query, cb: (r: QueryResult) => void): () => void {
    const w: RemoteWatch = { query, cb, running: false, again: false, stopped: false }
    this.watches.add(w)
    this.runWatch(w)
    this.schedule()
    return () => {
      w.stopped = true
      this.watches.delete(w)
      this.schedule()
    }
  }

  /**
   * Lance la requete d'une requete suivie. Deja en cours : une seule relance
   * de plus, a la fin (quel que soit le nombre de demandes entre-temps).
   * Rendu : la fin de la serie.
   */
  private runWatch(w: RemoteWatch): Promise<void> {
    if (w.stopped || this.disposed) return Promise.resolve()
    if (w.running) { w.again = true; return w.done ?? Promise.resolve() }
    // Pair en attente : la requete repartira a son retour.
    if (this.now() < this.blockedUntil) return Promise.resolve()
    w.running = true
    w.done = (async () => {
      do {
        w.again = false
        try {
          const r = await this.call<QueryResult>('query', 'run', w.query)
          if (!w.stopped) w.cb(r)
        } catch { /* refusee ou pair coupe : l'etat le dit, le fournisseur bascule */ }
      } while (w.again && !w.stopped && !this.disposed && this.now() >= this.blockedUntil)
      w.running = false
    })()
    return w.done
  }

  private rerunWatches(): Promise<void> {
    return Promise.all([...this.watches].map(w => this.runWatch(w))).then(() => undefined)
  }

  // ── Etat ─────────────────────────────────────────────────────────────────

  status(): VaultIndexerStatus {
    return this.st
  }

  onStatusChange(cb: (status: VaultIndexerStatus) => void): () => void {
    this.statusListeners.add(cb)
    this.schedule()
    return () => {
      this.statusListeners.delete(cb)
      this.schedule()
    }
  }

  private onIndexStateChange(cb: (state: IndexState) => void): () => void {
    let last = JSON.stringify(this.st.state)
    return this.onStatusChange(s => {
      const next = JSON.stringify(s.state)
      if (next === last) return
      last = next
      cb(s.state)
    })
  }

  private setStatus(next: VaultIndexerStatus): void {
    if (sameStatus(next, this.st)) return
    this.st = next
    for (const cb of [...this.statusListeners]) cb(next)
  }

  private blockedMessage(): string {
    switch (this.st.reason) {
      case 'none': return 'Ce vault n\'a pas de pair indexeur.'
      case 'organization': return 'Le pair indexeur de l\'organisation n\'est pas encore relie.'
      case 'busy': return 'Pair indexeur surcharge : nouvel essai bientot.'
      case 'denied': return 'Acces au pair indexeur refuse.'
      default: return 'Pair indexeur indisponible : nouvel essai bientot.'
    }
  }

  private succeeded(state: IndexState | undefined): void {
    const wasBlocked = this.blockedUntil > 0
    this.failures = 0
    this.blockedUntil = 0
    const next: VaultIndexerStatus = { ...this.st, state: state ?? (this.st.reason ? { status: 'ready' } : this.st.state) }
    delete next.reason
    delete next.retryAt
    if (next.mode === 'none' || next.mode === 'organization') next.mode = 'managed'
    if (next.mode === 'managed') delete next.url
    this.setStatus(next)
    // Le pair revient : les requetes suivies repartent de lui (check() s'en
    // charge quand c'est lui qui a constate le retour).
    if (wasBlocked && !this.checking) {
      void this.rerunWatches()
      this.schedule()
    }
  }

  /** Un echec : l'etat, l'attente avant le prochain essai, et l'erreur du contrat. */
  private failed(err: unknown): RemoteIndexError {
    const e = err instanceof IndexerHttpError ? err : undefined
    const error = toQueryError(err)
    if (!e || e.code === 'aborted') return error
    // Le pair a repondu (parametres refuses, pouvoir inconnu) : rien a changer.
    if (e.status === 400 || e.status === 413 || (e.status === 404 && /^unknown_/.test(e.code))) return error

    const now = this.now()
    let reason: IndexerDownReason
    let wait: number
    let mode: IndexerMode | undefined = this.st.mode
    let url: string | undefined = this.st.url
    if (e.status === 503 && e.mode === 'none') {
      reason = 'none'; mode = 'none'; url = undefined; wait = this.o.modeRetryMs
    } else if (e.status === 503 && e.mode === 'organization') {
      reason = 'organization'; mode = 'organization'; url = e.url; wait = this.o.modeRetryMs
    } else if (e.status === 401 || e.status === 403 || e.status === 404) {
      reason = 'denied'; wait = this.o.modeRetryMs
    } else {
      this.failures++
      const backoff = Math.min(this.o.retryMaxMs, this.o.retryBaseMs * 2 ** (this.failures - 1))
      reason = e.status === 429 ? 'busy' : 'down'
      wait = Math.max(e.retryAfterMs ?? 0, backoff)
    }
    this.blockedUntil = now + wait
    const state: IndexState = reason === 'busy' ? { status: 'lagging' } : { status: 'unavailable' }
    const next: VaultIndexerStatus = { ...this.st, state, reason, retryAt: this.blockedUntil }
    if (mode) next.mode = mode
    if (url) next.url = url
    else delete next.url
    this.setStatus(next)
    this.schedule()
    return error
  }

  // ── Modifications locales ────────────────────────────────────────────────

  noteLocalChange(docId?: string): void {
    if (this.disposed) return
    const now = this.now()
    this.pending.set(docId ?? '', { at: now, seq: this.st.seq })
    if (this.dirtyAt === null) { this.dirtyAt = now; this.dirtyChecks = 0 }
    this.publishPending()
    this.schedule()
  }

  private publishPending(): void {
    const n = this.pending.size - (this.pending.has('') ? 1 : 0)
    if (this.st.pending !== n) this.setStatus({ ...this.st, pending: n })
  }

  // ── Minuteur unique ──────────────────────────────────────────────────────

  private interested(): boolean {
    return this.watches.size > 0 || this.statusListeners.size > 0
  }

  /** Prochaine lecture de l'etat du pair : la plus proche des echeances. */
  private schedule(): void {
    if (this.disposed || this.checking) return
    const now = this.now()
    let at = Number.POSITIVE_INFINITY
    if (this.probe) at = now
    else if (now < this.blockedUntil) at = this.blockedUntil
    else {
      if (this.dirtyAt !== null) {
        const gap = Math.min(8_000, this.o.minCheckMs * 2 ** this.dirtyChecks)
        at = Math.max(this.dirtyAt + this.o.settleMs, this.lastCheck + gap)
      }
      if (this.interested()) {
        const busy = this.st.state.status === 'building' || this.st.state.status === 'lagging'
        at = Math.min(at, this.lastCheck + (busy ? this.o.busyPollMs : this.o.idlePollMs))
      }
    }
    if (this.timer !== null) { this.clearTimer(this.timer); this.timer = null }
    if (at === Number.POSITIVE_INFINITY) return
    this.timer = this.setTimer(() => {
      this.timer = null
      void this.check(false)
    }, Math.max(0, at - now))
  }

  refreshNow(): Promise<void> {
    return this.check(true)
  }

  private check(force: boolean): Promise<void> {
    if (this.disposed) return Promise.resolve()
    if (this.checking) return this.checking.then(() => (force ? this.check(true) : undefined))
    if (this.timer !== null) { this.clearTimer(this.timer); this.timer = null }
    const firstProbe = this.probe
    this.probe = false
    const startedAt = this.now()
    this.lastCheck = startedAt
    const wasBlocked = this.blockedUntil > 0
    const wasBuilding = this.st.state.status === 'building'
    const prevSeq = this.st.seq
    const run = async () => {
      let info: IndexStatusInfo | undefined
      try {
        info = await this.call<IndexStatusInfo>('index', 'status', {}, { force })
      } catch { /* l'etat est deja a jour (failed) */ }
      // Le reglage du vault, une fois : l'etat affiche dit qui sert le vault.
      if (firstProbe) void this.readSetting()
      if (!info) {
        this.expirePending(startedAt)
        return
      }
      const seq = typeof info.seq === 'number' ? info.seq : undefined
      const advanced = seq !== undefined && prevSeq !== undefined ? seq !== prevSeq : this.dirtyAt !== null
      const next: VaultIndexerStatus = { ...this.st }
      if (seq !== undefined) next.seq = seq
      if (typeof info.docs === 'number') next.docs = info.docs
      this.setStatus(next)
      // Une modification est vue quand le pair a avance depuis, et qu'elle est
      // plus ancienne que sa fenetre de regroupement. Deux coups d'oeil sans
      // que le pair bouge : rien a indexer (note ouverte, pas modifiee).
      const seen = startedAt - this.o.settleMs
      for (const [id, p] of this.pending) {
        if (p.at > seen) continue
        const indexed = seq === undefined || p.seq === undefined || seq > p.seq
        if (indexed || p.idle) this.pending.delete(id)
        else p.idle = true
      }
      this.dirtyAt = this.pending.size > 0 ? Math.min(...[...this.pending.values()].map(p => p.at)) : null
      if (advanced) this.dirtyChecks = 0
      else if (this.dirtyAt !== null) this.dirtyChecks++
      this.expirePending(startedAt)
      const building = info.status === 'building' || wasBuilding
      // Les requetes suivies viennent d'etre lancees au premier coup d'oeil ;
      // ensuite, seulement si l'index a bouge (ou sur demande).
      if (force || (!firstProbe && (advanced || wasBlocked || building))) await this.rerunWatches()
    }
    this.checking = run().finally(() => {
      this.checking = null
      this.schedule()
    })
    return this.checking
  }

  /** Notes trop anciennes : on cesse de les attendre. */
  private expirePending(now: number): void {
    for (const [id, p] of this.pending) if (now - p.at >= this.o.pendingTtlMs) this.pending.delete(id)
    this.dirtyAt = this.pending.size > 0 ? Math.min(...[...this.pending.values()].map(p => p.at)) : null
    this.publishPending()
  }

  // ── Reglage du vault ─────────────────────────────────────────────────────

  private async readSetting(): Promise<void> {
    try {
      const s = await this.http.getSetting(this.vaultId)
      if (this.disposed) return
      const next: VaultIndexerStatus = { ...this.st, mode: s.mode }
      if (s.mode === 'organization' && s.url) next.url = s.url
      else delete next.url
      this.setStatus(next)
    } catch { /* le reglage reste inconnu */ }
  }

  async getSetting(): Promise<VaultIndexerSetting> {
    try {
      const s = await this.http.getSetting(this.vaultId)
      const next: VaultIndexerStatus = { ...this.st, mode: s.mode }
      if (s.mode === 'organization' && s.url) next.url = s.url
      else delete next.url
      this.setStatus(next)
      return s
    } catch (err) {
      throw toSettingError(err)
    }
  }

  async setSetting(setting: VaultIndexerSettingInput): Promise<VaultIndexerSetting> {
    let saved: VaultIndexerSetting
    try {
      saved = await this.http.setSetting(this.vaultId, setting)
    } catch (err) {
      throw toSettingError(err)
    }
    // Nouveau reglage : on oublie les refus passes et on regarde tout de suite.
    this.failures = 0
    this.blockedUntil = 0
    const next: VaultIndexerStatus = { ...this.st, mode: saved.mode }
    delete next.reason
    delete next.retryAt
    if (saved.mode === 'organization' && saved.url) next.url = saved.url
    else delete next.url
    this.setStatus(next)
    void this.refreshNow()
    return saved
  }

  dispose(): void {
    this.disposed = true
    if (this.timer !== null) { this.clearTimer(this.timer); this.timer = null }
    for (const w of this.watches) w.stopped = true
    this.watches.clear()
    this.statusListeners.clear()
    this.pending.clear()
  }
}

/** L'etat d'index porte par un resultat (QueryResult, SearchResult) ou par index.status. */
function stateOf(result: unknown): IndexState | undefined {
  if (!result || typeof result !== 'object') return undefined
  const r = result as { index?: unknown; status?: unknown; progress?: unknown; lagMs?: unknown }
  const raw = (r.index && typeof r.index === 'object' ? r.index : r) as { status?: unknown; progress?: unknown; lagMs?: unknown }
  const status = raw.status
  if (status !== 'ready' && status !== 'building' && status !== 'lagging' && status !== 'unavailable') return undefined
  const state: IndexState = { status }
  if (typeof raw.progress === 'number') state.progress = raw.progress
  if (typeof raw.lagMs === 'number') state.lagMs = raw.lagMs
  return state
}

/** Erreur HTTP -> QueryErrorInfo du contrat. */
function toQueryError(err: unknown): RemoteIndexError {
  if (err instanceof RemoteIndexError) return err
  if (!(err instanceof IndexerHttpError)) {
    return new RemoteIndexError('unavailable', err instanceof Error ? err.message : String(err))
  }
  if ((err.status === 400 || err.status === 413) && QUERY_CODES.has(err.code)) {
    return new RemoteIndexError(err.code as QueryErrorInfo['code'], err.message)
  }
  if (err.status === 400 || err.status === 413) return new RemoteIndexError('invalid_query', err.message)
  return new RemoteIndexError('unavailable', err.message)
}

/** Erreur du reglage : un message lisible (403 : proprietaire seulement). */
function toSettingError(err: unknown): Error {
  if (err instanceof IndexerHttpError) {
    if (err.status === 403) return new Error('Seul le propriétaire du vault peut changer ce réglage.')
    if (err.status === 400) return new Error(err.message || 'Réglage refusé.')
    if (err.status === 0) return new Error('Serveur injoignable.')
    return new Error(err.message || `Erreur ${err.status}`)
  }
  return err instanceof Error ? err : new Error(String(err))
}
