// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Cote fil principal : les fils qui portent les index. Un vault va toujours
// au meme fil (shardOf). Admission des appels (file bornee par fil ->
// 429), delais, generation de chaque index (pour le cache), et reprise d'un
// fil qui tombe (il est relance ; le flux est rejoue depuis la derniere
// position sure).
import { Worker } from 'node:worker_threads'
import type { IndexPower } from '@savoire/indexer-core'
import type { FeedChange } from './backend'
import { HttpError, overloaded, unavailable } from './errors'
import type { WireError } from './errors'
import type { Logger } from './log'
import { Shard, shardOf, share } from './shard'
import type { FromShard, ShardInit, ToShard } from './shard'
import type { StoreSnapshot } from './store'

interface Link {
  send(msg: ToShard): void
  terminate(): Promise<void>
}

interface Pending {
  resolve: (v: unknown) => void
  reject: (e: unknown) => void
  call: boolean
}

interface Slot {
  link?: Link
  alive: boolean
  pending: Map<number, Pending>
  inflight: number
  restarts: number
}

export interface PoolOptions {
  count: number
  /** 0 : dans le fil principal. */
  workers: boolean
  workerFile?: string
  init: Omit<ShardInit, 'index' | 'count'>
  maxQueue: number
  retryAfterS: number
  unavailableRetryAfterS: number
  log: Logger
  /** Un fil est reparti de zero : lui redonner epoque, vaults... */
  onRestart: (index: number) => void
  powers?: () => IndexPower[]
}

export class ShardPool {
  private readonly slots: Slot[]
  private nextId = 1
  private stopping = false
  /** Generation de l'index de chaque vault : une entree de cache n'est bonne que pour la sienne. */
  readonly gens = new Map<string, number>()
  crashes = 0

  constructor(private readonly opts: PoolOptions) {
    this.slots = Array.from({ length: opts.count }, () => ({ alive: false, pending: new Map(), inflight: 0, restarts: 0 }))
    for (let i = 0; i < opts.count; i++) this.spawn(i)
  }

  get count(): number {
    return this.slots.length
  }

  get alive(): boolean {
    return this.slots.every(s => s.alive)
  }

  inflight(): number[] {
    return this.slots.map(s => s.inflight)
  }

  get perShardQueue(): number {
    return share(this.opts.maxQueue, this.slots.length)
  }

  shardOf(vaultId: string): number {
    return shardOf(vaultId, this.slots.length)
  }

  private spawn(i: number): void {
    const s = this.slots[i]!
    const init: ShardInit = { ...this.opts.init, index: i, count: this.slots.length }
    const onMessage = (msg: FromShard) => this.receive(i, msg)
    if (!this.opts.workers) {
      const shard = new Shard(init, this.opts.log.child({ shard: i }), m => queueMicrotask(() => onMessage(m)), this.opts.powers)
      s.link = { send: m => queueMicrotask(() => shard.handle(m)), terminate: async () => {} }
      s.alive = true
      return
    }
    const worker = new Worker(this.opts.workerFile!, { workerData: { role: 'shard', init } })
    s.link = { send: m => worker.postMessage(m), terminate: async () => { await worker.terminate() } }
    s.alive = true
    worker.on('message', onMessage)
    worker.on('error', err => this.opts.log.error('fil en erreur', { shard: i, err }))
    worker.on('exit', code => {
      s.alive = false
      for (const p of s.pending.values()) p.reject(unavailable('Fil d\'indexation arrete.', this.opts.unavailableRetryAfterS))
      s.pending.clear()
      s.inflight = 0
      if (this.stopping) return
      this.crashes++
      s.restarts++
      this.opts.log.error('fil d indexation tombe : relance', { shard: i, code, restarts: s.restarts })
      setTimeout(() => {
        if (this.stopping) return
        this.spawn(i)
        this.opts.onRestart(i)
      }, Math.min(30_000, 500 * 2 ** Math.min(6, s.restarts - 1))).unref()
    })
  }

  private receive(i: number, msg: FromShard): void {
    if (msg.t === 'gen') {
      this.gens.set(msg.vaultId, msg.gen)
      return
    }
    const s = this.slots[i]!
    const p = s.pending.get(msg.id)
    if (!p) return
    s.pending.delete(msg.id)
    if (p.call) s.inflight--
    if (msg.ok) p.resolve(msg.value)
    else p.reject(HttpError.fromWire(msg.error as WireError))
  }

  send(i: number, msg: ToShard): void {
    const s = this.slots[i]!
    if (s.alive) s.link!.send(msg)
  }

  broadcast(msg: ToShard): void {
    for (let i = 0; i < this.slots.length; i++) this.send(i, msg)
  }

  private request<T>(i: number, build: (id: number) => ToShard, call = false): Promise<T> {
    const s = this.slots[i]!
    if (!s.alive) return Promise.reject(unavailable('Fil d\'indexation en redemarrage.', this.opts.unavailableRetryAfterS))
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      s.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, call })
      if (call) s.inflight++
      s.link!.send(build(id))
    })
  }

  /** Changements du flux : chacun a son fil ; tous apprennent la position atteinte. */
  dispatch(changes: readonly FeedChange[], upTo: number, polledAt: number): void {
    const parts: FeedChange[][] = this.slots.map(() => [])
    for (const c of changes) parts[this.shardOf(c.vaultId)]!.push(c)
    for (let i = 0; i < this.slots.length; i++) this.send(i, { t: 'changes', changes: parts[i]!, upTo, polledAt })
  }

  own(ids: readonly string[], full: boolean): void {
    const parts: string[][] = this.slots.map(() => [])
    for (const id of ids) parts[this.shardOf(id)]!.push(id)
    for (let i = 0; i < this.slots.length; i++) if (full || parts[i]!.length) this.send(i, { t: 'own', ids: parts[i]!, full })
  }

  /**
   * Appel `capacite.methode`. 429 si la file du fil est pleine ; 503 au-dela
   * du delai (la tache en attente est abandonnee).
   */
  async call(vaultId: string, capability: string, method: string, params: unknown, timeoutMs: number, signal?: AbortSignal): Promise<{ result: unknown; gen: number }> {
    const i = this.shardOf(vaultId)
    const s = this.slots[i]!
    if (s.inflight >= this.perShardQueue) throw overloaded(this.opts.retryAfterS)
    let callId = 0
    const p = this.request<{ result: unknown; gen: number }>(i, id => {
      callId = id
      return { t: 'call', id, vaultId, capability, method, params, timeoutMs }
    }, true)
    // Le fil peut etre pris par une longue tache SQLite : le delai est tenu ici aussi.
    const r = await new Promise<{ result: unknown; gen: number }>((resolve, reject) => {
      const timer = setTimeout(() => onAbort(), timeoutMs + 250)
      const onAbort = () => {
        this.send(i, { t: 'abort', id: callId })
        reject(unavailable('Delai depasse : le pair indexeur est trop charge.', this.opts.unavailableRetryAfterS))
      }
      if (signal?.aborted) onAbort()
      signal?.addEventListener('abort', onAbort, { once: true })
      p.then(resolve, reject).finally(() => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
      })
    })
    if ((this.gens.get(vaultId) ?? -1) < r.gen) this.gens.set(vaultId, r.gen)
    return r
  }

  snapshots(): Promise<(StoreSnapshot | null)[]> {
    return Promise.all(this.slots.map((s, i) => s.alive
      ? this.request<StoreSnapshot>(i, id => ({ t: 'snapshot', id })).catch(() => null)
      : Promise.resolve(null)))
  }

  /** Plus petite position sure du flux, tous fils confondus (null : rien n'attend). */
  async lowWater(): Promise<number | null | undefined> {
    const all = await Promise.all(this.slots.map((s, i) => s.alive
      ? this.request<number | null>(i, id => ({ t: 'lowWater', id })).catch(() => undefined)
      : Promise.resolve(undefined)))
    // undefined : un fil n'a pas repondu, on ne sait pas.
    if (all.some(x => x === undefined)) return undefined
    const vals = all.filter((x): x is number => typeof x === 'number')
    return vals.length ? Math.min(...vals) : null
  }

  async stop(timeoutMs: number): Promise<void> {
    this.stopping = true
    await Promise.all(this.slots.map((s, i) => s.alive
      ? this.request(i, id => ({ t: 'stop', id, timeoutMs })).catch(err => this.opts.log.warn('arret d un fil', { shard: i, err }))
      : Promise.resolve()))
    await Promise.all(this.slots.map(s => s.link?.terminate().catch(() => undefined)))
    for (const s of this.slots) s.alive = false
  }
}
