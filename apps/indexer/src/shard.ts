// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Un fil d'execution qui porte une partie des vaults (FNV-1a de l'id modulo
// le nombre de fils). Messages simples (clonables) avec le fil principal :
// le meme code tourne dans un Worker ou dans le fil principal (WORKERS=0,
// tests).
import { join } from 'node:path'
import { officialExtractors } from './extractors'
import { getHeapStatistics } from 'node:v8'
import type { IndexPower } from '@savoire/indexer-core'
import { BackendClient } from './backend'
import { bearerSourceFor } from './serviceAuth'
import type { FeedChange } from './backend'
import type { IndexerConfig } from './config'
import { toWire, unavailable } from './errors'
import type { WireError } from './errors'
import type { Logger } from './log'
import { SlotAbortedError } from './sched'
import { VaultStore } from './store'
import type { StoreSnapshot } from './store'
import { fnv1a32 } from './util'

export type ToShard =
  | { t: 'epoch'; epoch: string; changed: boolean }
  | { t: 'own'; ids: string[]; full: boolean }
  | { t: 'changes'; changes: FeedChange[]; upTo: number; polledAt: number }
  | { t: 'call'; id: number; vaultId: string; capability: string; method: string; params: unknown; timeoutMs: number }
  | { t: 'abort'; id: number }
  | { t: 'snapshot'; id: number }
  | { t: 'lowWater'; id: number }
  | { t: 'stop'; id: number; timeoutMs: number }

export type FromShard =
  | { t: 'reply'; id: number; ok: true; value: unknown }
  | { t: 'reply'; id: number; ok: false; error: WireError }
  | { t: 'gen'; vaultId: string; gen: number }

export interface ShardInit {
  index: number
  count: number
  config: IndexerConfig
  version: string
}

export function shardOf(vaultId: string, count: number): number {
  return count <= 1 ? 0 : fnv1a32(vaultId) % count
}

/** Part d'un reglage global revenant a un fil (au moins 1). */
export function share(total: number, count: number): number {
  return Math.max(1, Math.ceil(total / Math.max(1, count)))
}

export class Shard {
  private readonly store: VaultStore
  private readonly calls = new Map<number, AbortController>()

  constructor(
    private readonly init: ShardInit,
    private readonly log: Logger,
    private readonly emit: (msg: FromShard) => void,
    powers?: () => IndexPower[],
  ) {
    const c = init.config
    const count = Math.max(1, init.count)
    this.store = new VaultStore({
      dataDir: c.dataDir,
      shard: init.index,
      maxOpen: share(c.maxOpen, count),
      sqliteCacheKiB: c.sqliteCacheKiB,
      debounceMs: c.debounceMs,
      debounceMaxMs: c.debounceMaxMs,
      orphanTtlMs: c.orphanTtlMs,
      buildConcurrency: share(c.buildConcurrency, count),
      buildBatch: c.buildBatch,
      fetchConcurrency: c.fetchConcurrency,
      lagWarnMs: c.lagWarnMs,
      feedStaleMs: c.feedStaleMs,
      statsIntervalMs: c.statsIntervalMs,
      unavailableRetryAfterS: c.unavailableRetryAfterS,
      // Fichiers (PDF, Word...) : extracteurs des plugins officiels seulement.
      ...(c.extractFiles === 'on' ? { extractor: officialExtractors({ ocr: c.ocr === 'on', cacheDir: join(c.dataDir, 'ocr') }) } : {}),
      ...(powers ? { powers } : {}),
    }, metrics => new BackendClient({
      url: c.backendUrl, token: bearerSourceFor(c), name: c.name, timeoutMs: c.backendTimeoutMs, retries: c.backendRetries,
      maxBytes: c.maxDocBytes, userAgent: `savoire-indexer/${init.version}`,
    }, metrics), log, (vaultId, gen) => this.emit({ t: 'gen', vaultId, gen }))
    this.store.start(id => shardOf(id, count) === init.index)
  }

  handle(msg: ToShard): void {
    switch (msg.t) {
      case 'epoch': this.store.setEpoch(msg.epoch, msg.changed); return
      case 'own': this.store.own(msg.ids, msg.full); return
      case 'changes': this.store.changes(msg.changes, msg.upTo, msg.polledAt); return
      case 'abort': this.calls.get(msg.id)?.abort(); return
      case 'call': this.call(msg); return
      case 'snapshot': this.reply(msg.id, () => ({ ...this.store.snapshot(), heapUsed: getHeapStatistics().used_heap_size })); return
      case 'lowWater': this.reply(msg.id, () => this.store.lowWater()); return
      case 'stop': this.reply(msg.id, () => this.store.stop(msg.timeoutMs)); return
    }
  }

  snapshot(): StoreSnapshot {
    return this.store.snapshot()
  }

  private reply(id: number, fn: () => unknown): void {
    Promise.resolve().then(fn).then(
      value => this.emit({ t: 'reply', id, ok: true, value }),
      err => this.emit({ t: 'reply', id, ok: false, error: toWire(err, this.init.config.unavailableRetryAfterS) }))
  }

  private call(msg: Extract<ToShard, { t: 'call' }>): void {
    const ac = new AbortController()
    this.calls.set(msg.id, ac)
    const timer = setTimeout(() => ac.abort(), msg.timeoutMs)
    const retry = this.init.config.unavailableRetryAfterS
    this.store.call(msg.vaultId, msg.capability, msg.method, msg.params, ac.signal).then(
      value => this.emit({ t: 'reply', id: msg.id, ok: true, value }),
      err => {
        const e = err instanceof SlotAbortedError || (ac.signal.aborted && (err as { code?: string })?.code === 'unavailable')
          ? unavailable('Delai depasse : le pair indexeur est trop charge.', retry).toWire()
          : toWire(err, retry)
        if (e.status === 500) this.log.error('appel en echec', { vault: msg.vaultId, capability: msg.capability, method: msg.method, err })
        this.emit({ t: 'reply', id: msg.id, ok: false, error: e })
      },
    ).finally(() => {
      clearTimeout(timer)
      this.calls.delete(msg.id)
    })
  }
}
