// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Index local dans un Worker : le fil principal lui parle par messages.
//
//  - serveLocalIndex(port, open) : cote Worker. Ouvre l'index a la premiere
//    demande (`open`), puis execute les demandes ;
//  - WorkerLocalIndex : cote fil principal, un ILocalIndex qui envoie chaque
//    appel au Worker.
//
// Protocole : une demande { id, op, ... } ; une reponse { id, ok, value } ou
// { id, ok: false, error: { code, message } } (codes de QueryErrorInfo, plus
// unknown_capability et unknown_method) ; des evenements { event: 'changed' }
// et { event: 'state', state }. Une demande annulee (AbortSignal) envoie
// { op: 'cancel', target } : le Worker la laisse tomber si elle n'a pas
// encore commence, et la promesse rejette tout de suite (code unavailable,
// comme VaultIndex).
//
// Aucune API du DOM : le port est decrit ici (Worker, DedicatedWorkerGlobalScope
// et MessagePort conviennent).
import type {
  IQueryEngine, ISearchEngine, IndexState, PropertySchema, Query, QueryResult, SearchQuery, SearchResult,
} from '@savoire/plugin-api'
import { IndexError } from '../errors'
import type { IndexErrorCode } from '../errors'
import type { NoteInput, NoteRecord } from '../extract/note'
import type { MethodOptions } from '../power'
import type { ILocalIndex, LocalIndexInfo } from './LocalIndex'

/** Ce qu'on utilise d'un Worker, de son contexte global ou d'un MessagePort. */
export interface MessagePortLike {
  postMessage(message: unknown): void
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void
  removeEventListener?(type: 'message', listener: (event: { data: unknown }) => void): void
  /** MessagePort : a demarrer apres addEventListener. */
  start?(): void
}

/** Ce que demande le fil principal a l'ouverture. */
export interface LocalOpenRequest {
  /** Nom du fichier de l'index (un par vault). */
  name: string
  /** Persistance voulue ; le Worker se replie sur la memoire s'il ne peut pas. */
  persistence: 'opfs' | 'memory'
  schema?: PropertySchema
}

export type LocalIndexOpener = (request: LocalOpenRequest) => Promise<ILocalIndex>

type Request =
  | { id: number; op: 'open'; request: LocalOpenRequest }
  | { id: number; op: 'call'; capability: string; method: string; params: unknown }
  | { id: number; op: 'cancel'; target: number }
  | { id: number; op: 'applyDocs'; inputs: readonly NoteInput[]; sources?: Record<string, string> }
  | { id: number; op: 'applyRecords'; records: readonly NoteRecord[]; sources?: Record<string, string> }
  | { id: number; op: 'removeDocs'; ids: readonly string[] }
  | { id: number; op: 'sources' }
  | { id: number; op: 'paths' }
  | { id: number; op: 'rowIds'; base: string }
  | { id: number; op: 'markBuilt' }
  | { id: number; op: 'setState'; state: IndexState }
  | { id: number; op: 'close' }

type Reply =
  | { id: number; ok: true; value: unknown }
  | { id: number; ok: false; error: { code?: string; message: string } }

type WorkerEvent = { event: 'changed' } | { event: 'state'; state: IndexState }

const ERROR_CODES: ReadonlySet<string> = new Set<IndexErrorCode>([
  'invalid_query', 'invalid_cursor', 'too_complex', 'unavailable', 'unknown_capability', 'unknown_method',
])

function errorInfo(err: unknown): { code?: string; message: string } {
  const code = (err as { code?: unknown })?.code
  const message = err instanceof Error ? err.message : String(err)
  return typeof code === 'string' && ERROR_CODES.has(code) ? { code, message } : { message }
}

function cancelled(): IndexError {
  return new IndexError('unavailable', 'Requete annulee.')
}

// ── Cote Worker ────────────────────────────────────────────────────────────

export function serveLocalIndex(port: MessagePortLike, open: LocalIndexOpener): void {
  let index: ILocalIndex | null = null
  let opening: Promise<ILocalIndex> | null = null
  const running = new Map<number, AbortController>()
  const post = (m: Reply | WorkerEvent) => port.postMessage(m)

  const need = (): ILocalIndex => {
    if (!index) throw new IndexError('unavailable', 'Index non ouvert.')
    return index
  }

  async function run(req: Exclude<Request, { op: 'cancel' }>): Promise<unknown> {
    switch (req.op) {
      case 'open': {
        if (opening) throw new Error('Index deja ouvert.')
        opening = open(req.request)
        index = await opening
        index.onChange(() => post({ event: 'changed' }))
        index.onStateChange(state => post({ event: 'state', state }))
        return index.info
      }
      case 'call': {
        const ctl = new AbortController()
        running.set(req.id, ctl)
        try {
          return await need().call(req.capability, req.method, req.params, { signal: ctl.signal })
        } finally {
          running.delete(req.id)
        }
      }
      case 'applyDocs': return need().applyDocs(req.inputs, req.sources)
      case 'applyRecords': return need().applyRecords(req.records, req.sources)
      case 'removeDocs': return need().removeDocs(req.ids)
      case 'sources': return [...(await need().sources())]
      case 'paths': return [...(await need().paths())]
      case 'rowIds': return need().rowIds(req.base)
      case 'markBuilt': return need().markBuilt()
      case 'setState': return need().setState(req.state)
      case 'close': {
        const current = index
        index = null
        await current?.close()
        return null
      }
    }
  }

  port.addEventListener('message', event => {
    const req = event.data as Request
    if (!req || typeof req !== 'object' || typeof req.id !== 'number') return
    if (req.op === 'cancel') { running.get(req.target)?.abort(); return }
    void run(req).then(
      value => post({ id: req.id, ok: true, value: value ?? null }),
      err => post({ id: req.id, ok: false, error: errorInfo(err) }),
    )
  })
  port.start?.()
}

// ── Cote fil principal ─────────────────────────────────────────────────────

interface Pending {
  resolve(value: unknown): void
  reject(err: unknown): void
}

export interface WorkerLocalIndexOptions {
  /** Appele par close() (terminer le Worker). */
  dispose?: () => void
}

export class WorkerLocalIndex implements ILocalIndex {
  private next = 1
  private readonly pending = new Map<number, Pending>()
  private current: IndexState = { status: 'ready' }
  private readonly stateListeners = new Set<(s: IndexState) => void>()
  private readonly changeListeners = new Set<() => void>()
  private closed = false
  private query?: IQueryEngine
  private search?: ISearchEngine
  info: LocalIndexInfo = { persistence: 'memory', rebuildRequired: true }

  private constructor(private readonly port: MessagePortLike, private readonly options: WorkerLocalIndexOptions) {
    port.addEventListener('message', event => this.receive(event.data))
    port.start?.()
  }

  /** Ouvre l'index dans le Worker joint par ce port. */
  static async open(port: MessagePortLike, request: LocalOpenRequest, options: WorkerLocalIndexOptions = {}): Promise<WorkerLocalIndex> {
    const client = new WorkerLocalIndex(port, options)
    try {
      client.info = await client.send<LocalIndexInfo>({ op: 'open', request })
    } catch (err) {
      client.fail(err)
      options.dispose?.()
      throw err
    }
    return client
  }

  /** Le Worker est perdu (erreur, arret) : tout ce qui attend echoue, l'etat passe a indisponible. */
  fail(err: unknown = new IndexError('unavailable', 'Index local indisponible.')): void {
    for (const p of this.pending.values()) p.reject(err)
    this.pending.clear()
    this.closed = true
    this.applyState({ status: 'unavailable' })
  }

  private receive(data: unknown): void {
    const m = data as Reply | WorkerEvent
    if (!m || typeof m !== 'object') return
    if ('event' in m) {
      if (m.event === 'changed') for (const cb of [...this.changeListeners]) cb()
      else if (m.event === 'state') this.applyState(m.state)
      return
    }
    const p = this.pending.get(m.id)
    if (!p) return
    this.pending.delete(m.id)
    if (m.ok) p.resolve(m.value)
    else p.reject(m.error.code && ERROR_CODES.has(m.error.code)
      ? new IndexError(m.error.code as IndexErrorCode, m.error.message)
      : new Error(m.error.message))
  }

  private applyState(state: IndexState): void {
    this.current = state
    for (const cb of [...this.stateListeners]) cb(state)
  }

  private send<T>(req: { op: Request['op'] } & Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    if (this.closed) return Promise.reject(new IndexError('unavailable', 'Index local ferme.'))
    if (signal?.aborted) return Promise.reject(cancelled())
    const id = this.next++
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: v => resolve(v as T), reject })
      if (signal) {
        signal.addEventListener('abort', () => {
          if (!this.pending.delete(id)) return
          this.port.postMessage({ id: this.next++, op: 'cancel', target: id })
          reject(cancelled())
        }, { once: true })
      }
      this.port.postMessage({ ...req, id })
    })
  }

  call(capability: string, method: string, params: unknown, options?: MethodOptions): Promise<unknown> {
    return this.send({ op: 'call', capability, method, params }, options?.signal)
  }

  async applyDocs(inputs: readonly NoteInput[], sources?: Record<string, string>): Promise<void> {
    await this.send({ op: 'applyDocs', inputs, sources })
  }

  async applyRecords(records: readonly NoteRecord[], sources?: Record<string, string>): Promise<void> {
    await this.send({ op: 'applyRecords', records, sources })
  }

  async removeDocs(ids: readonly string[]): Promise<void> {
    if (ids.length) await this.send({ op: 'removeDocs', ids })
  }

  async sources(): Promise<Map<string, string>> {
    return new Map(await this.send<[string, string][]>({ op: 'sources' }))
  }

  async paths(): Promise<Map<string, string>> {
    return new Map(await this.send<[string, string][]>({ op: 'paths' }))
  }

  rowIds(base: string): Promise<string[]> {
    return this.send({ op: 'rowIds', base })
  }

  async markBuilt(): Promise<void> {
    await this.send({ op: 'markBuilt' })
  }

  setState(state: IndexState): void {
    // L'etat revient du Worker (evenement) ; on l'applique tout de suite ici.
    this.applyState(state)
    void this.send({ op: 'setState', state }).catch(() => undefined)
  }

  state(): IndexState {
    return this.current
  }

  onStateChange(cb: (state: IndexState) => void): () => void {
    this.stateListeners.add(cb)
    return () => { this.stateListeners.delete(cb) }
  }

  onChange(cb: () => void): () => void {
    this.changeListeners.add(cb)
    return () => { this.changeListeners.delete(cb) }
  }

  queryEngine(): IQueryEngine {
    this.query ??= {
      query: (q: Query, options?: { signal?: AbortSignal }) => this.call('query', 'run', q, options) as Promise<QueryResult>,
      watch: (q: Query, cb: (r: QueryResult) => void) => this.watch(q, cb),
      state: () => this.state(),
      onStateChange: cb => this.onStateChange(cb),
    }
    return this.query
  }

  searchEngine(): ISearchEngine {
    this.search ??= {
      search: (q: SearchQuery, options?: { signal?: AbortSignal }) => this.call('search', 'run', q, options) as Promise<SearchResult>,
      state: () => this.state(),
      onStateChange: cb => this.onStateChange(cb),
    }
    return this.search
  }

  async close(): Promise<void> {
    if (this.closed) return
    try {
      await this.send({ op: 'close' })
    } finally {
      this.closed = true
      this.options.dispose?.()
    }
  }

  /** Comme VaultIndex : relancee a chaque changement, au plus une fois en attente. */
  private watch(query: Query, cb: (r: QueryResult) => void): () => void {
    let stopped = false
    let running = false
    let again = false
    const run = () => {
      if (stopped) return
      if (running) { again = true; return }
      running = true
      this.call('query', 'run', query)
        .then(r => { if (!stopped) cb(r as QueryResult) }, () => { /* requete invalide ou index ferme : rien */ })
        .finally(() => {
          running = false
          if (again) { again = false; run() }
        })
    }
    const off = this.onChange(run)
    run()
    return () => { stopped = true; off() }
  }
}
