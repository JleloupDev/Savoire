// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Suivi du flux de changements du backend (fil principal).
//
//  1. liste des vaults de l'instance (GET vaults?instance=) ;
//  2. flux en boucle (GET changes?instance=&since=) : cadence rapide quand
//     il bouge, ralentie au repos ; pages de 2 000 pendant un rattrapage ;
//  3. epoque : si elle change (base du backend recreee), on repart de 0 et
//     tous les index sont reconstruits (a cote) ;
//  4. position sure ecrite sur disque chaque seconde : la plus petite des
//     positions que les fils n'ont pas encore traitees. Un redemarrage (ou un
//     fil relance) reprend de la, sans perte ;
//  5. liste relue regulierement : un vault qui n'est plus a l'instance devient
//     orphelin dans son fil.
import { BackendError } from './backend'
import type { BackendClient } from './backend'
import type { Logger } from './log'
import type { Counter } from './metrics'
import type { ShardPool } from './shards'
import { loadState, saveState } from './state'
import type { PeerState } from './state'
import { sleep } from './util'

export interface FeedOptions {
  name: string
  dataDir: string
  feedLimit: number
  feedActiveMs: number
  feedIdleMs: number
  feedStaleMs: number
  vaultsRefreshMs: number
}

export interface FeedMetrics {
  polls: Counter
  epochs: Counter
}

const CATCH_UP_LIMIT = 2000

export class Feed {
  readonly owned = new Set<string>()
  listed = false
  epoch?: string
  cursor = 0
  lastOkAt = 0
  lastPollAt = 0
  lastError?: string
  /** Position sure ecrite sur disque. */
  persisted = 0
  catchingUp = false
  private saved?: PeerState
  private forceRebuild = false
  private stopping = false
  private readonly ac = new AbortController()
  private rewindTo?: number
  private listing?: Promise<void>
  private seenSinceList = new Set<string>()
  private lastListAt = 0
  private loops: Promise<void>[] = []

  constructor(
    private readonly opts: FeedOptions,
    private readonly backend: BackendClient,
    private readonly pool: ShardPool,
    private readonly log: Logger,
    private readonly metrics: FeedMetrics,
  ) {
    const saved = loadState(opts.dataDir)
    if (saved && saved.name !== opts.name) {
      // Un autre nom = d'autres vaults : la position ne vaut plus rien.
      this.log.warn('nom d instance change : tout est relu', { before: saved.name, now: opts.name })
      this.forceRebuild = true
    } else if (saved) {
      this.saved = saved
      this.cursor = saved.cursor
      this.persisted = saved.cursor
    }
  }

  /** Le flux est suivi : liste lue, derniere reponse recente. */
  get following(): boolean {
    return this.listed && this.epoch !== undefined && Date.now() - this.lastOkAt < this.opts.feedStaleMs
  }

  start(): void {
    this.loops.push(this.run(), this.persistLoop(), this.listLoop())
  }

  async stop(): Promise<void> {
    this.stopping = true
    this.ac.abort(new Error('arret'))
    await Promise.allSettled(this.loops)
    await this.persist().catch(err => this.log.warn('derniere ecriture de l etat', { err }))
  }

  /** Un fil a ete relance : il a perdu ce qu'il n'avait pas ecrit. On rejoue depuis la position sure. */
  rewind(): void {
    this.rewindTo = this.persisted
  }

  /** Vault inconnu : relire la liste (au plus toutes les 5 s), puis dire s'il est a nous. */
  async ensureOwned(vaultId: string, waitMs: number): Promise<boolean> {
    if (this.owned.has(vaultId)) return true
    if (!this.listed || Date.now() - this.lastListAt < 5000) return false
    await Promise.race([this.refreshVaults('vault inconnu').catch(() => undefined), sleep(waitMs)])
    return this.owned.has(vaultId)
  }

  refreshVaults(reason: string): Promise<void> {
    this.listing ??= (async () => {
      const seen = this.seenSinceList = new Set()
      try {
        const list = await this.backend.vaults(this.ac.signal)
        const ids = new Set(list.map(v => v.vaultId))
        for (const id of seen) ids.add(id)
        const before = this.owned.size
        this.owned.clear()
        for (const id of ids) this.owned.add(id)
        this.lastListAt = Date.now()
        if (!this.listed) {
          this.listed = true
          this.log.info('vaults de l instance', { count: ids.size })
        } else if (ids.size !== before) {
          this.log.info('liste des vaults relue', { reason, before, now: ids.size })
        }
        // Avant l'epoque, les fils ne doivent rien ouvrir : la liste part au premier tour du flux.
        if (this.epoch !== undefined) this.pool.own([...this.owned], true)
      } finally {
        this.listing = undefined
      }
    })()
    return this.listing
  }

  private async run(): Promise<void> {
    let backoff = 1000
    let delay = 0
    while (!this.stopping) {
      try {
        if (!this.listed) await this.refreshVaults('demarrage')
        if (this.rewindTo !== undefined) {
          this.log.warn('flux rejoue depuis la position sure', { from: this.rewindTo, was: this.cursor })
          this.cursor = Math.min(this.cursor, this.rewindTo)
          this.rewindTo = undefined
        }
        const since = this.cursor
        const limit = this.catchingUp ? CATCH_UP_LIMIT : this.opts.feedLimit
        this.lastPollAt = Date.now()
        const page = await this.backend.changes(since, limit, this.ac.signal)
        this.metrics.polls.inc({ result: 'ok' })
        if (this.epoch === undefined || page.epoch !== this.epoch) {
          if (this.onEpoch(page.epoch)) continue
        }
        const now = Date.now()
        for (const c of page.changes) {
          if (c.kind === 'vault-deleted') this.owned.delete(c.vaultId)
          else {
            this.owned.add(c.vaultId)
            this.seenSinceList.add(c.vaultId)
          }
        }
        this.pool.dispatch(page.changes, page.last, now)
        if (this.rewindTo === undefined) this.cursor = Math.max(this.cursor, page.last)
        this.lastOkAt = now
        this.lastError = undefined
        backoff = 1000
        const full = page.changes.length >= limit
        if (full !== this.catchingUp) this.log.info(full ? 'rattrapage du flux' : 'flux a jour', { cursor: this.cursor })
        this.catchingUp = full
        delay = full ? 0 : page.changes.length ? this.opts.feedActiveMs : Math.min(this.opts.feedIdleMs, Math.max(this.opts.feedActiveMs, delay * 2, 50))
        if (delay) await sleep(delay, this.ac.signal)
      } catch (err) {
        if (this.stopping) break
        this.metrics.polls.inc({ result: 'error' })
        const msg = err instanceof BackendError ? `${err.status} ${err.code}` : (err as Error).message
        if (msg !== this.lastError) {
          const hint = err instanceof BackendError && err.status === 401 ? ' Verifier SAVOIRE_INDEXER_TOKEN et Indexer:ServiceToken.'
            : err instanceof BackendError && err.code === 'unknown_instance' ? ' Verifier SAVOIRE_INDEXER_NAME et Indexer:Instances.'
              : err instanceof BackendError && err.status === 404 ? ' API interne absente : Indexer:ServiceToken est-il configure ?' : ''
          this.log.error('flux de changements indisponible.' + hint, { err, retryInMs: backoff })
        }
        this.lastError = msg
        await sleep(backoff, this.ac.signal).catch(() => undefined)
        backoff = Math.min(30_000, backoff * 2)
      }
    }
  }

  /** Rend vrai s'il faut relire le flux depuis le debut. */
  private onEpoch(epoch: string): boolean {
    const first = this.epoch === undefined
    const known = first ? this.saved?.epoch : this.epoch
    this.epoch = epoch
    if (this.forceRebuild || (known !== undefined && known !== epoch)) {
      this.metrics.epochs.inc()
      this.log.warn('epoque du flux changee : relecture depuis 0 et reconstruction de tous les index', { before: known, now: epoch })
      this.forceRebuild = false
      this.cursor = 0
      this.persisted = 0
      this.pool.broadcast({ t: 'epoch', epoch, changed: true })
      this.pool.own([...this.owned], true)
      if (!first) void this.refreshVaults('epoque changee').catch(() => undefined)
      return true
    }
    this.pool.broadcast({ t: 'epoch', epoch, changed: false })
    if (first) {
      this.pool.own([...this.owned], true)
      this.log.info('flux suivi', { epoch, from: this.cursor })
    }
    return false
  }

  /** Ecrit la position sure : jamais au-dela d'un changement non traite. */
  async persist(): Promise<void> {
    if (this.epoch === undefined) return
    const cursor = this.cursor
    const lw = await this.pool.lowWater()
    if (lw === undefined) return
    const safe = Math.max(0, lw === null ? cursor : Math.min(cursor, lw))
    if (safe === this.persisted && this.saved?.epoch === this.epoch) return
    const state: PeerState = { version: 1, name: this.opts.name, epoch: this.epoch, cursor: safe }
    saveState(this.opts.dataDir, state)
    this.saved = state
    this.persisted = safe
  }

  private async persistLoop(): Promise<void> {
    while (!this.stopping) {
      await sleep(1000, this.ac.signal).catch(() => undefined)
      if (this.stopping) break
      await this.persist().catch(err => this.log.warn('ecriture de l etat impossible', { err }))
    }
  }

  private async listLoop(): Promise<void> {
    while (!this.stopping) {
      await sleep(this.opts.vaultsRefreshMs, this.ac.signal).catch(() => undefined)
      if (this.stopping) break
      if (!this.listed) continue
      await this.refreshVaults('periodique').catch(err => this.log.warn('liste des vaults illisible', { err }))
    }
  }
}
