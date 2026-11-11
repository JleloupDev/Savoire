// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Les index d'un fil d'execution (« shard ») : chaque vault de ce fil a son
// fichier SQLite ({dataDir}/{vaultId}.sqlite, WAL), ouvert a la demande et
// ferme quand il sort du cache (LRU). Un vault vit dans un seul fil : un seul
// ecrivain. Tout ce qui touche SQLite passe par le creneau du fil
// (sched.ts : appels, puis mises a jour, puis constructions) ; les lectures
// du backend se font hors creneau.
//
// Cycle d'un vault :
//  - construction EN PLACE (fichier absent, noyau d'une autre version,
//    construction interrompue, fichier illisible) : le fichier se remplit par
//    lots, il repond pendant ce temps (status building, progress) ; les
//    changements recus attendent la fin ;
//  - construction A COTE (version d'un pouvoir changee, epoque du flux
//    changee, index perime d'un vault revenu) : {id}.sqlite.building se
//    construit pendant que l'ancien repond (pouvoirs intacts) et suit le flux ;
//    ce que le flux a change pendant ce temps est rejoue sur le nouveau, puis
//    bascule (renommage) ;
//  - au fil de l'eau : les changements d'une note sont regroupes
//    (DEBOUNCE), puis la note est relue et indexee ; l'arbre du vault est
//    relu et compare a l'index (ajouts, renommages, corbeille, suppressions) ;
//    les lots de lignes legeres des bases sont relus ;
//  - orphelin (le vault n'est plus a cette instance) : ferme, marque
//    {id}.sqlite.stale, supprime apres ORPHAN_TTL ; s'il revient, il est
//    reconstruit a cote ;
//  - vault-deleted : ferme et supprime.
//
// Chaque traitement relit l'etat COURANT du backend : l'ordre des lectures
// suffit a converger. Les ecritures d'un meme index ne se croisent pas : une
// unite (lecture puis ecriture) a la fois par vault.
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  NOTE_EXTENSIONS, VaultIndex, baseManifestFromUpdates, defaultPowers, diffTree, extOf, isTrashPath, lightRowRecord,
  lotDocId, lotRowsFromUpdates, noteInputFromUpdates, parseLotDocId, propertySchemaFromUpdates, propertySchemaKey,
  vaultTreeFromUpdates,
} from '@savoire/indexer-core'
import { MAX_EXTRACT_BYTES, extractedToMarkdown, type ExtractorSpec } from '@savoire/plugin-api'
import type { BaseManifest, IndexInspection, IndexPower, IndexStatus, NoteInput, NoteRecord } from '@savoire/indexer-core'
import { NodeSqliteDriver } from '@savoire/indexer-core/node'
import { BASE_LOT_COUNT, baseLotOf } from '@savoire/plugin-api'
import type { IndexState, PropertySchema } from '@savoire/plugin-api'
import type { BackendClient, FeedChange, UpdatesLog } from './backend'
import { BackendError } from './backend'
import { HttpError, notOwner, unavailable } from './errors'
import type { Logger } from './log'
import { Counter, Histogram, gauge } from './metrics'
import type { Family } from './metrics'
import { BUILD, INTERACTIVE, LIVE, PRIORITY_NAMES, PrioritySlot } from './sched'
import type { Priority } from './sched'
import { Mutex, Semaphore, isVaultId, mapLimit, sleep } from './util'

export interface StoreOptions {
  dataDir: string
  shard: number
  maxOpen: number
  sqliteCacheKiB: number
  debounceMs: number
  debounceMaxMs: number
  orphanTtlMs: number
  buildConcurrency: number
  buildBatch: number
  fetchConcurrency: number
  lagWarnMs: number
  feedStaleMs: number
  statsIntervalMs: number
  unavailableRetryAfterS: number
  /** Pouvoirs inscrits (tests : versions modifiees). */
  powers?: () => IndexPower[]
  /** Extracteur d'un fichier (PDF, Word...) : plugins officiels seulement. Absent : fichiers ignores. */
  extractor?: (path: string) => ExtractorSpec | undefined
}

/** Pourquoi un vault est (re)construit. */
export type RebuildReason = 'missing' | 'core' | 'incomplete' | 'corrupt' | 'schema' | 'epoch' | 'stale' | 'types'
const IN_PLACE: ReadonlySet<RebuildReason> = new Set(['missing', 'core', 'incomplete', 'corrupt'])

interface Pending {
  seq: number
  firstAt: number
  lastAt: number
}

interface Handle {
  file: string
  driver: NodeSqliteDriver
  index: VaultIndex
  powers: ReadonlySet<string>
  stateJson: string
  off: () => void
}

interface BaseInfo {
  path: string
  lotCount?: number
  /** Lots connus (manifeste). */
  lots?: number[]
  /** Ses lignes sont dans l'index (lues depuis le demarrage, ou deja la). */
  checked: boolean
}

class Vault {
  owned = false
  serving?: Handle
  target?: Handle
  rebuild?: RebuildReason
  checked = false
  building = false
  queued = false
  demanded = false
  progress?: number
  buildAbort?: AbortController
  failures = 0
  retryAt = 0
  readonly docs = new Map<string, Pending>()
  tree?: Pending
  replay?: { docs: Set<string>; tree: boolean }
  appliedSeq = 0
  maxSeen = 0
  gen = 0
  readonly unit = new Mutex()
  liveRunning = false
  liveFailures = 0
  lastUsed = 0
  orphanSince?: number
  bases?: Map<string, BaseInfo>
  stats = { docs: 0, bytes: 0, at: 0, dirty: true }
  lastWriteAt = 0
  /** Dernier etat rendu (pour faire avancer la generation quand il change sans ecriture). */
  lastStatus = ''
  /** Types des proprietes du vault (reglages) ; schemaKey undefined : pas encore lus. */
  schema?: PropertySchema
  schemaKey?: string
  /** Types changes pendant une construction : en refaire une ensuite. */
  typesDirty = false

  constructor(readonly id: string, readonly file: string) {}

  get pendingCount(): number {
    return this.docs.size + (this.tree ? 1 : 0)
  }

  oldestPending(): number | undefined {
    let t = this.tree?.firstAt
    for (const p of this.docs.values()) if (t === undefined || p.firstAt < t) t = p.firstAt
    return t
  }

  minPendingSeq(): number | undefined {
    let s = this.tree?.seq
    for (const p of this.docs.values()) if (s === undefined || p.seq < s) s = p.seq
    return s
  }
}

/** Ce que le flux a demande pour un vault, regroupe : notes, lots, bases, arbre. */
interface Work {
  docs: Map<string, number>
  treeSeq?: number
}

export interface VaultSnapshot {
  id: string
  status: IndexState['status']
  progress?: number
  lagMs: number
  rebuild?: RebuildReason
  pending: number
  docs: number
  bytes: number
  seq: number
  open: boolean
  orphan: boolean
}

export interface StoreSnapshot {
  shard: number
  families: Family[]
  vaults: VaultSnapshot[]
  queue: { interactive: number; live: number; build: number }
  open: number
  building: number
  buildQueued: number
  /** Tas JavaScript du fil (octets). */
  heapUsed?: number
}

const NOTE_EXT = NOTE_EXTENSIONS
const ROWS_PER_TX = 500
const LOT_SIG_CACHE = 64
const SUFFIXES = ['', '-wal', '-shm', '-journal']

function isNotePath(path: string): boolean {
  return !isTrashPath(path) && NOTE_EXT.has(extOf(path))
}

function isBasePath(path: string): boolean {
  return !isTrashPath(path) && extOf(path) === 'base'
}

function bytesOf(log: UpdatesLog): Uint8Array[] {
  return log.updates.map(u => Buffer.from(u, 'base64'))
}

function isCorruption(err: unknown): boolean {
  const m = String((err as Error)?.message ?? '')
  return /not a database|malformed|corrupt|SQLITE_CORRUPT|SQLITE_NOTADB/i.test(m)
}

export class VaultStore {
  private readonly vaults = new Map<string, Vault>()
  readonly slot = new PrioritySlot()
  private readonly fetches: Semaphore
  private readonly buildQueue: Vault[] = []
  private readonly building = new Set<Vault>()
  private readonly checkQueue: Vault[] = []
  private checking = false
  private openCount = 0
  private epoch?: string
  private feedPos = 0
  private polledAt = Date.now()
  private timer?: NodeJS.Timeout
  private sweepTimer?: NodeJS.Timeout
  private lagTimer?: NodeJS.Timeout
  private stopping = false
  private emptyIndex?: Promise<VaultIndex>
  private readonly lotSigs = new Map<string, Map<string, string>>()
  /** Vaults qui ont des changements en attente. */
  private readonly pendingVaults = new Set<Vault>()
  private readonly powers: () => IndexPower[]
  private readonly bg = new Set<Promise<unknown>>()

  // Metriques du fil.
  private readonly m = {
    changes: new Counter('savoire_indexer_changes_total', 'Changements recus du flux, par type.'),
    docs: new Counter('savoire_indexer_docs_indexed_total', 'Documents ecrits dans un index, par origine (build, live).'),
    removed: new Counter('savoire_indexer_docs_removed_total', 'Documents retires d\'un index (corbeille, suppression).'),
    skipped: new Counter('savoire_indexer_docs_skipped_total', 'Documents ignores, par raison.'),
    builds: new Counter('savoire_indexer_builds_total', 'Constructions terminees, par mode et resultat.'),
    buildSeconds: new Histogram('savoire_indexer_build_duration_seconds', 'Duree des constructions de vault.', [1, 5, 15, 30, 60, 120, 300, 600, 1800, 3600]),
    live: new Counter('savoire_indexer_live_units_total', 'Mises a jour au fil de l\'eau, par resultat.'),
    errors: new Counter('savoire_indexer_errors_total', 'Erreurs, par sorte.'),
    calls: new Counter('savoire_indexer_shard_calls_total', 'Appels executes par le fil.'),
    backendRequests: new Counter('savoire_indexer_backend_requests_total', 'Appels au backend, par route et statut.'),
    backendSeconds: new Histogram('savoire_indexer_backend_request_duration_seconds', 'Duree des appels au backend, par route.'),
    evictions: new Counter('savoire_indexer_evictions_total', 'Fichiers fermes par le cache (LRU).'),
    deleted: new Counter('savoire_indexer_vaults_deleted_total', 'Index supprimes, par raison (vault-deleted, orphan).'),
  }

  constructor(
    private readonly opts: StoreOptions,
    backendFactory: (metrics: { requests: Counter; duration: Histogram }) => BackendClient,
    private readonly log: Logger,
    private readonly onGen: (vaultId: string, gen: number) => void,
  ) {
    this.fetches = new Semaphore(opts.fetchConcurrency)
    this.powers = opts.powers ?? defaultPowers
    this.backend = backendFactory({ requests: this.m.backendRequests, duration: this.m.backendSeconds })
  }

  private readonly backend: BackendClient

  // ── Demarrage, arret ─────────────────────────────────────────────────────

  /** Inventaire du dossier : index existants, marques d'orphelins, constructions interrompues. */
  start(owns: (vaultId: string) => boolean): void {
    mkdirSync(this.opts.dataDir, { recursive: true })
    for (const name of readdirSync(this.opts.dataDir)) {
      const m = /^(.+)\.sqlite(\.building(-wal|-shm|-journal)?|\.stale)?$/.exec(name)
      if (!m || !isVaultId(m[1]) || !owns(m[1]!)) continue
      const id = m[1]!
      if (m[2]?.startsWith('.building')) { this.rm(join(this.opts.dataDir, name)); continue }
      const v = this.vault(id)
      if (m[2] === '.stale') v.orphanSince = this.readStale(v) ?? Date.now()
    }
    this.sweepTimer = setInterval(() => this.sweep(), Math.min(60_000, Math.max(1000, this.opts.orphanTtlMs / 4)))
    this.sweepTimer.unref()
    // Un vault qui passe « en retard » sans rien ecrire : sa generation avance (le cache ne le cache pas).
    this.lagTimer = setInterval(() => {
      for (const v of this.pendingVaults) {
        if (v.lastStatus && this.stateOf(v).status !== v.lastStatus) { v.lastStatus = ''; this.bump(v) }
      }
    }, 1000)
    this.lagTimer.unref()
  }

  async stop(timeoutMs: number): Promise<void> {
    this.stopping = true
    if (this.timer) clearTimeout(this.timer)
    if (this.sweepTimer) clearInterval(this.sweepTimer)
    if (this.lagTimer) clearInterval(this.lagTimer)
    for (const v of this.vaults.values()) v.buildAbort?.abort(new Error('arret'))
    // Les unites en cours finissent (ecritures entieres) ; rien de nouveau ne part.
    const deadline = Date.now() + timeoutMs
    while (this.bg.size && Date.now() < deadline) {
      await Promise.race([Promise.allSettled([...this.bg]), sleep(Math.max(1, deadline - Date.now()))])
    }
    this.slot.cancelAll(unavailable('Arret du pair indexeur.', this.opts.unavailableRetryAfterS))
    for (const v of this.vaults.values()) {
      await this.closeHandle(v, 'serving')
      await this.closeHandle(v, 'target')
    }
    if (this.emptyIndex) await (await this.emptyIndex).close().catch(() => undefined)
  }

  private track<T>(p: Promise<T>, what: string, vaultId?: string): void {
    const tracked = p.catch(err => {
      if (this.stopping) return
      this.m.errors.inc({ kind: what })
      this.log.error(`echec : ${what}`, { vault: vaultId, err })
    }).finally(() => { this.bg.delete(tracked) })
    this.bg.add(tracked)
  }

  // ── Messages du fil principal ────────────────────────────────────────────

  /**
   * Epoque du flux. `changed` : la base du backend a ete recreee, les
   * sequences repartent de zero : tout est reconstruit (a cote).
   */
  setEpoch(epoch: string, changed: boolean): void {
    this.epoch = epoch
    if (!changed) return
    this.feedPos = 0
    for (const v of this.vaults.values()) {
      v.appliedSeq = 0
      v.maxSeen = 0
      v.docs.clear()
      v.tree = undefined
      this.pendingVaults.delete(v)
      if (!v.owned) continue
      if (!v.rebuild || !IN_PLACE.has(v.rebuild)) v.rebuild = v.rebuild ?? 'epoch'
      this.enqueueBuild(v)
    }
    this.pumpBuilds()
  }

  /** Vaults de ce fil possedes par l'instance. `full` : la liste complete (les autres deviennent orphelins). */
  own(ids: readonly string[], full: boolean): void {
    const set = new Set(ids)
    for (const id of set) {
      if (!isVaultId(id)) continue
      const v = this.vault(id)
      if (v.owned) continue
      v.owned = true
      if (v.orphanSince !== undefined) {
        // Revenu : l'index a manque des changements.
        v.orphanSince = undefined
        if (existsSync(v.file)) v.rebuild = v.rebuild ?? 'stale'
      }
      this.enqueueCheck(v)
    }
    if (full) {
      for (const v of this.vaults.values()) {
        if (set.has(v.id)) continue
        if (v.owned || (v.orphanSince === undefined && existsSync(v.file))) this.track(this.orphan(v), 'orphan', v.id)
      }
    }
    this.pumpChecks()
  }

  /** Changements du flux pour ce fil. `upTo` : position du flux deja distribuee. */
  changes(list: readonly FeedChange[], upTo: number, polledAt: number): void {
    this.polledAt = polledAt
    const now = Date.now()
    for (const c of list) {
      if (!isVaultId(c.vaultId)) { this.m.skipped.inc({ reason: 'bad_vault_id' }); continue }
      this.m.changes.inc({ kind: c.kind })
      if (c.kind === 'vault-deleted') {
        const v = this.vaults.get(c.vaultId)
        this.track(this.deleteVault(v ?? this.vault(c.vaultId), 'vault-deleted'), 'delete', c.vaultId)
        continue
      }
      const v = this.vault(c.vaultId)
      if (!v.owned) {
        v.owned = true
        if (v.orphanSince !== undefined) { v.orphanSince = undefined; if (existsSync(v.file)) v.rebuild = v.rebuild ?? 'stale' }
        this.enqueueCheck(v)
      }
      v.maxSeen = Math.max(v.maxSeen, c.seq)
      if (c.kind === 'vault') {
        v.tree = merge(v.tree, c.seq, now)
        this.pendingVaults.add(v)
      } else if (c.kind === 'document' && typeof c.docId === 'string' && c.docId) {
        v.docs.set(c.docId, merge(v.docs.get(c.docId), c.seq, now))
        this.pendingVaults.add(v)
      } else if (c.kind === 'settings') {
        // Types des proprietes : relus, et l'index reconstruit s'ils ont change.
        this.track(this.onTypes(v), 'types', v.id)
      } else {
        this.m.skipped.inc({ reason: 'unknown_change' })
      }
    }
    this.feedPos = Math.max(this.feedPos, upTo)
    this.pumpChecks()
    this.schedule()
  }

  /** Plus petite sequence encore a traiter, moins un ; null si rien n'attend. */
  lowWater(): number | null {
    let min: number | undefined
    for (const v of this.pendingVaults) {
      // Un vault a reconstruire relira tout : ses changements en attente ne retiennent pas le flux.
      if (!v.owned || v.rebuild) continue
      const s = v.minPendingSeq()
      if (s !== undefined && (min === undefined || s < min)) min = s
    }
    return min === undefined ? null : min - 1
  }

  // ── Appels ───────────────────────────────────────────────────────────────

  /** Execute `capacite.methode` sur l'index du vault. */
  async call(vaultId: string, capability: string, method: string, params: unknown, signal: AbortSignal): Promise<{ result: unknown; gen: number }> {
    const v = this.vaults.get(vaultId)
    if (!v?.owned) throw notOwner(vaultId)
    if (v.rebuild && !v.building) {
      // Demande : sa construction passe devant les autres.
      v.demanded = true
      this.enqueueBuild(v)
      this.pumpBuilds()
    }
    this.m.calls.inc({ capability })
    return this.slot.run(INTERACTIVE, async () => {
      if (signal.aborted) throw unavailable('Delai depasse.', this.opts.unavailableRetryAfterS)
      if (!v.owned) throw notOwner(vaultId)
      const h = await this.handleFor(v, capability)
      const result = await h.call(capability, method, params, { signal })
      return { result, gen: v.gen }
    }, signal)
  }

  /** L'index qui sait repondre a cette capacite. */
  private async handleFor(v: Vault, capability: string): Promise<VaultIndex> {
    let serving = v.serving
    if (!serving) serving = await this.openServing(v)
    if (serving.powers.has(capability) || !this.powers().some(p => p.name === capability)) {
      this.refreshState(v, serving)
      return serving.index
    }
    if (v.target) {
      this.refreshState(v, v.target)
      return v.target.index
    }
    // Pouvoir en cours de reconstruction, pas encore commence : index vide.
    this.emptyIndex ??= VaultIndex.open(NodeSqliteDriver.open(':memory:'), { powers: this.powers() })
    const empty = await this.emptyIndex
    empty.setState(this.stateOf(v))
    return empty
  }

  // ── Etat ─────────────────────────────────────────────────────────────────

  private stateOf(v: Vault, now = Date.now()): IndexState {
    if (v.rebuild) return { status: 'building', progress: round(v.progress ?? 0) }
    let lag = 0
    const oldest = v.oldestPending()
    if (oldest !== undefined) lag = now - oldest
    const feedAge = now - this.polledAt
    if (feedAge > this.opts.feedStaleMs) lag = Math.max(lag, feedAge)
    if (lag > this.opts.lagWarnMs) return { status: 'lagging', lagMs: Math.round(lag / 1000) * 1000 }
    return { status: 'ready' }
  }

  private refreshState(v: Vault, h: Handle): void {
    const st = this.stateOf(v)
    v.lastStatus = st.status
    const json = JSON.stringify(st)
    if (json === h.stateJson) return
    h.stateJson = json
    h.index.setState(st)
  }

  private bump(v: Vault): void {
    v.gen++
    v.stats.dirty = true
    this.onGen(v.id, v.gen)
  }

  // ── Fichiers ─────────────────────────────────────────────────────────────

  private vault(id: string): Vault {
    let v = this.vaults.get(id)
    if (!v) {
      v = new Vault(id, join(this.opts.dataDir, `${id}.sqlite`))
      this.vaults.set(id, v)
    }
    return v
  }

  private rm(file: string): void {
    try { rmSync(file, { force: true }) } catch (err) { this.log.warn('suppression impossible', { file, err }) }
  }

  private rmIndex(base: string): void {
    for (const s of SUFFIXES) this.rm(base + s)
  }

  private staleFile(v: Vault): string {
    return v.file + '.stale'
  }

  private readStale(v: Vault): number | undefined {
    try {
      const since = Number(JSON.parse(readFileSync(this.staleFile(v), 'utf8')).since)
      return Number.isFinite(since) ? since : undefined
    } catch {
      return undefined
    }
  }

  /** Ce qu'il faut faire d'un index existant. */
  private decide(info: IndexInspection, v: Vault): RebuildReason | undefined {
    if (!info.exists) return 'missing'
    if (info.coreChanged) return 'core'
    if (!info.built) return 'incomplete'
    if (info.changed.length) return 'schema'
    if (this.epoch !== undefined && info.host['epoch'] !== this.epoch) return 'epoch'
    if (existsSync(this.staleFile(v))) return 'stale'
    return undefined
  }

  /** Types du vault lus, differents de ceux de l'index : reconstruire. */
  private typesChanged(info: IndexInspection, v: Vault): RebuildReason | undefined {
    if (v.schemaKey === undefined || !info.exists) return undefined
    return (info.host['types'] ?? '') !== v.schemaKey ? 'types' : undefined
  }

  /** Relit les types des proprietes du vault (HORS creneau : lecture du backend). */
  private async loadSchema(v: Vault, signal?: AbortSignal): Promise<void> {
    const log = await this.fetch(() => this.backend.settings(v.id, 'properties', signal))
    const schema: PropertySchema = log && log.format === 'yjs' ? propertySchemaFromUpdates(bytesOf(log)) : { properties: [] }
    v.schema = schema
    v.schemaKey = propertySchemaKey(schema)
    v.serving?.index.setSchema(schema)
    v.target?.index.setSchema(schema)
  }

  /** Les types du vault ont change (flux « settings ») : reconstruire a cote si l'index en a d'autres. */
  private async onTypes(v: Vault): Promise<void> {
    const before = v.schemaKey
    await this.loadSchema(v)
    if (before === v.schemaKey || !v.owned) return
    // Pas encore verifie : la verification comparera.
    if (!v.checked && !v.serving) return
    if (v.building) { v.typesDirty = true; return }
    v.rebuild = v.rebuild ?? 'types'
    this.enqueueBuild(v)
    this.pumpBuilds()
  }

  /** A appeler DANS le creneau. */
  private async openHandle(file: string, powers: IndexPower[], schema?: PropertySchema): Promise<Handle> {
    const driver = NodeSqliteDriver.open(file)
    try {
      await driver.exec(`PRAGMA cache_size = -${this.opts.sqliteCacheKiB}`)
      const index = await VaultIndex.open(driver, { powers, schema })
      this.openCount++
      return { file, driver, index, powers: new Set(powers.map(p => p.name)), stateJson: '', off: () => {} }
    } catch (err) {
      await driver.close().catch(() => undefined)
      throw err
    }
  }

  /** Ouvre l'index qui repond (DANS le creneau). Decide aussi s'il faut le reconstruire. */
  private async openServing(v: Vault): Promise<Handle> {
    if (v.serving) { v.lastUsed = Date.now(); return v.serving }
    let reason: RebuildReason | undefined
    let info: IndexInspection
    let driver: NodeSqliteDriver | undefined
    try {
      driver = NodeSqliteDriver.open(v.file)
      info = await VaultIndex.inspect(driver, { powers: this.powers() })
      reason = this.decide(info, v) ?? this.typesChanged(info, v)
      await driver.close()
      driver = undefined
    } catch (err) {
      await driver?.close().catch(() => undefined)
      if (!isCorruption(err)) throw err
      this.log.error('index illisible : supprime et reconstruit', { vault: v.id, err })
      this.m.errors.inc({ kind: 'corrupt' })
      this.rmIndex(v.file)
      info = { exists: false, rebuildRequired: true, coreChanged: true, built: false, seq: 0, intact: [], changed: [], host: {} }
      reason = 'corrupt'
    }
    // Une raison deja connue (epoque, perime, construction a cote en cours) l'emporte.
    if (v.rebuild && !(reason && IN_PLACE.has(reason))) reason = v.rebuild
    const all = this.powers()
    const powers = reason === 'schema' ? all.filter(p => info.intact.includes(p.name)) : all
    const h = await this.openHandle(v.file, powers, v.schema)
    h.off = h.index.onChange(() => this.bump(v))
    v.serving = h
    v.lastUsed = Date.now()
    v.appliedSeq = reason && (IN_PLACE.has(reason) || reason === 'epoch') ? 0 : await h.index.seq()
    v.checked = true
    if (reason) {
      v.rebuild = reason
      this.enqueueBuild(v)
      this.pumpBuilds()
    }
    this.refreshState(v, h)
    await this.evict()
    return h
  }

  private async closeHandle(v: Vault, which: 'serving' | 'target'): Promise<void> {
    const h = v[which]
    if (!h) return
    v[which] = undefined
    h.off()
    this.openCount--
    try {
      await h.index.close()
    } catch (err) {
      this.log.warn('fermeture difficile', { vault: v.id, err })
    }
  }

  /** Ferme les fichiers les moins recemment utilises au-dela de MAX_OPEN (DANS le creneau). */
  private async evict(): Promise<void> {
    if (this.openCount <= this.opts.maxOpen) return
    const idle = [...this.vaults.values()]
      .filter(v => v.serving && !v.building && !v.liveRunning && !v.unit.busy && !v.target)
      .sort((a, b) => a.lastUsed - b.lastUsed)
    for (const v of idle) {
      if (this.openCount <= this.opts.maxOpen) break
      await this.closeHandle(v, 'serving')
      this.m.evictions.inc()
    }
  }

  // ── Verification au demarrage ────────────────────────────────────────────

  private enqueueCheck(v: Vault): void {
    if (v.checked || v.serving) return
    if (!existsSync(v.file)) {
      v.checked = true
      v.rebuild = 'missing'
      this.enqueueBuild(v)
      this.pumpBuilds()
      return
    }
    this.checkQueue.push(v)
  }

  private pumpChecks(): void {
    if (this.checking || !this.checkQueue.length || this.stopping) return
    this.checking = true
    this.track((async () => {
      try {
        while (this.checkQueue.length && !this.stopping) {
          const v = this.checkQueue.shift()!
          if (v.checked || v.serving || !v.owned) continue
          if (v.schemaKey === undefined) {
            await this.loadSchema(v).catch(err => this.log.warn('types des proprietes illisibles', { vault: v.id, err }))
          }
          await this.slot.run(BUILD, async () => {
            if (v.serving || v.checked) return
            let driver: NodeSqliteDriver | undefined
            try {
              driver = NodeSqliteDriver.open(v.file)
              const info = await VaultIndex.inspect(driver, { powers: this.powers() })
              const reason = this.decide(info, v) ?? this.typesChanged(info, v)
              if (reason && !(v.rebuild && !IN_PLACE.has(reason))) v.rebuild = reason
              if (!v.rebuild || v.rebuild === 'schema' || v.rebuild === 'stale') v.appliedSeq = info.seq
              v.stats = { docs: v.stats.docs, bytes: this.fileBytes(v.file), at: 0, dirty: true }
            } catch (err) {
              if (!isCorruption(err)) throw err
              this.log.error('index illisible : supprime et reconstruit', { vault: v.id, err })
              this.m.errors.inc({ kind: 'corrupt' })
              await driver?.close().catch(() => undefined)
              driver = undefined
              this.rmIndex(v.file)
              v.rebuild = 'corrupt'
            } finally {
              await driver?.close().catch(() => undefined)
            }
            v.checked = true
          })
          if (v.rebuild) this.enqueueBuild(v)
        }
      } finally {
        this.checking = false
      }
      this.pumpBuilds()
      this.schedule()
    })(), 'check')
  }

  // ── Au fil de l'eau ──────────────────────────────────────────────────────

  /** Prochain passage : au plus tot des echeances (regroupement). */
  private schedule(): void {
    if (this.stopping) return
    let next = Infinity
    for (const v of this.pendingVaults) {
      if (!v.pendingCount) { this.pendingVaults.delete(v); continue }
      if (!v.owned || v.liveRunning || !this.liveAllowed(v)) continue
      next = Math.min(next, this.dueAt(v))
    }
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    if (next === Infinity) return
    this.timer = setTimeout(() => this.pumpLive(), Math.max(0, next - Date.now()))
  }

  private dueAt(v: Vault): number {
    let due = Infinity
    const d = (p: Pending) => Math.min(p.lastAt + this.opts.debounceMs, p.firstAt + this.opts.debounceMaxMs)
    if (v.tree) due = Math.min(due, d(v.tree))
    for (const p of v.docs.values()) due = Math.min(due, d(p))
    return due
  }

  /** Les changements ne s'appliquent pas pendant une construction en place, ni avant la verification. */
  private liveAllowed(v: Vault): boolean {
    if (!v.checked && !v.serving) return false
    return !(v.rebuild && IN_PLACE.has(v.rebuild))
  }

  private pumpLive(): void {
    this.timer = undefined
    if (this.stopping) return
    const now = Date.now()
    for (const v of this.pendingVaults) {
      if (!v.owned || v.liveRunning || !v.pendingCount || !this.liveAllowed(v)) continue
      const work = this.takeDue(v, now)
      if (!work) continue
      v.liveRunning = true
      this.track(this.liveUnit(v, work).finally(() => {
        v.liveRunning = false
        this.schedule()
      }), 'live', v.id)
    }
    this.schedule()
  }

  private takeDue(v: Vault, now: number): Work | undefined {
    const due = (p: Pending) => Math.min(p.lastAt + this.opts.debounceMs, p.firstAt + this.opts.debounceMaxMs) <= now
    const work: Work = { docs: new Map() }
    if (v.tree && due(v.tree)) work.treeSeq = v.tree.seq
    for (const [id, p] of v.docs) if (due(p)) work.docs.set(id, p.seq)
    return work.treeSeq !== undefined || work.docs.size ? work : undefined
  }

  /** Retire du pending ce qui a ete traite (sauf ce qui a change depuis). */
  private settle(v: Vault, work: Work): void {
    if (work.treeSeq !== undefined && v.tree?.seq === work.treeSeq) v.tree = undefined
    for (const [id, seq] of work.docs) if (v.docs.get(id)?.seq === seq) v.docs.delete(id)
    if (!v.pendingCount) this.pendingVaults.delete(v)
  }

  private async liveUnit(v: Vault, work: Work): Promise<void> {
    await v.unit.run(async () => {
      if (!v.owned || this.stopping) return
      const t0 = performance.now()
      // Deja applique (reprise apres redemarrage) : rien a faire.
      for (const [id, seq] of work.docs) if (seq <= v.appliedSeq) { work.docs.delete(id); if (v.docs.get(id)?.seq === seq) v.docs.delete(id) }
      if (work.treeSeq !== undefined && work.treeSeq <= v.appliedSeq) { if (v.tree?.seq === work.treeSeq) v.tree = undefined; work.treeSeq = undefined }
      if (!work.docs.size && work.treeSeq === undefined) return
      try {
        await this.process(v, 'serving', [...work.docs.keys()], work.treeSeq !== undefined, LIVE, 'live')
        v.liveFailures = 0
      } catch (err) {
        this.m.live.inc({ result: 'error' })
        if (err instanceof BackendError && err.status === 404) {
          // Vault parti (le flux dira vault-deleted) : rien a reessayer.
          this.settle(v, work)
          return
        }
        // Reessai plus tard : les changements restent en attente.
        v.liveFailures++
        const wait = Math.min(30_000, 1000 * 2 ** Math.min(5, v.liveFailures - 1))
        this.log.warn('mise a jour reportee', { vault: v.id, retryInMs: wait, err })
        await sleep(wait)
        return
      }
      if (v.target && v.replay) {
        for (const id of work.docs.keys()) v.replay.docs.add(id)
        if (work.treeSeq !== undefined) v.replay.tree = true
      }
      this.settle(v, work)
      const seq = this.lowWaterOf(v)
      if (seq > v.appliedSeq) {
        await this.slot.run(LIVE, async () => {
          const h = v.serving ?? await this.openServing(v)
          await h.index.setSeq(seq)
        })
        v.appliedSeq = seq
      }
      this.m.live.inc({ result: 'ok' })
      this.log.debug('mise a jour', { vault: v.id, docs: work.docs.size, tree: work.treeSeq !== undefined, ms: Math.round(performance.now() - t0) })
    })
  }

  /** Sequence a ecrire dans l'index : tout ce qui la precede est traite. */
  private lowWaterOf(v: Vault, floor = 0): number {
    const min = v.minPendingSeq()
    return min === undefined ? Math.max(floor, v.maxSeen) : Math.max(floor, Math.min(v.maxSeen, min - 1))
  }

  /**
   * Applique a un index (`serving` ou `target`) l'etat courant de documents
   * et, au besoin, de l'arbre : notes, lots de lignes legeres, bases.
   */
  private async process(v: Vault, which: 'serving' | 'target', docIds: readonly string[], tree: boolean, prio: Priority, origin: string): Promise<void> {
    const handle = async () => {
      const h = which === 'serving' ? (v.serving ?? await this.openServing(v)) : v.target
      if (!h) throw new Error('index cible ferme')
      v.lastUsed = Date.now()
      return h
    }
    const lots = new Map<string, Set<number>>()
    const others: string[] = []
    for (const id of docIds) {
      const lot = parseLotDocId(id)
      if (lot) {
        let s = lots.get(lot.baseId)
        if (!s) lots.set(lot.baseId, s = new Set())
        s.add(lot.lot)
      } else {
        others.push(id)
      }
    }
    // Les lots ont besoin de connaitre les bases du vault (corbeille comprise).
    if ((lots.size || others.length) && !v.bases) tree = true

    const space = which === 'target' ? 'T' : 'S'
    const toFetch = new Map<string, string>()
    const basesToIndex = new Set<string>()
    const basesToRefresh = new Set<string>()
    if (tree) {
      const log = await this.fetch(() => this.backend.tree(v.id))
      if (!log) throw new BackendError(404, 'not_found', 'Vault parti.', false)
      const vt = vaultTreeFromUpdates(bytesOf(log))
      const notes = new Map<string, string>()
      const liveBases = new Map<string, string>()
      for (const [id, path] of vt.docs) {
        if (isNotePath(path) || this.extractable(path)) notes.set(id, path)
        else if (isBasePath(path)) liveBases.set(id, path)
      }
      await this.slot.run(prio, async () => {
        const h = await handle()
        const indexed = await h.index.paths()
        const diff = diffTree(indexed, notes)
        if (diff.removed.length) {
          await h.index.removeDocs(diff.removed)
          this.m.removed.inc({ origin }, diff.removed.length)
        }
        for (const mv of diff.moved) {
          const r = await h.index.moveDoc(mv.id, mv.to)
          if (r === 'missing') toFetch.set(mv.id, mv.to)
        }
        for (const a of diff.added) toFetch.set(a.id, a.path)
        // Bases : celles qui ne sont plus la (supprimees, a la corbeille) perdent leurs lignes.
        const withRows = new Set(await h.index.bases())
        for (const b of withRows) {
          if (liveBases.has(b)) continue
          const ids = await h.index.rowIds(b)
          for (let i = 0; i < ids.length; i += ROWS_PER_TX) await h.index.removeDocs(ids.slice(i, i + ROWS_PER_TX))
          this.m.removed.inc({ origin }, ids.length)
          this.forgetLots(v.id, b)
        }
        const before = v.bases
        const next = new Map<string, BaseInfo>()
        for (const [b, path] of liveBases) {
          const old = before?.get(b)
          // Une base revenue (de la corbeille) ou nouvelle sans lignes indexees : a lire en entier.
          const info: BaseInfo = { path, lotCount: old?.lotCount, lots: old?.lots, checked: (old?.checked ?? false) || withRows.has(b) }
          next.set(b, info)
          if (!info.checked) basesToIndex.add(b)
        }
        v.bases = next
      })
    }

    // Notes connues de l'index (ou de l'arbre qu'on vient de lire).
    if (others.length) {
      const known = await this.slot.run(prio, async () => (await handle()).index.paths(others))
      for (const id of others) {
        const path = known.get(id) ?? toFetch.get(id)
        if (path) toFetch.set(id, path)
        else if (v.bases?.has(id)) basesToRefresh.add(id) // le document d'une base : son manifeste a pu changer
        else this.m.skipped.inc({ reason: 'not_indexed' })
      }
    }

    if (toFetch.size) await this.writeNotes(v, handle, [...toFetch].map(([id, path]) => ({ id, path })), prio, origin)

    for (const b of basesToIndex) await this.indexBase(v, handle, space, b, prio, origin)
    for (const b of basesToRefresh) if (!basesToIndex.has(b)) await this.refreshBase(v, handle, space, b, prio, origin)
    for (const [b, ns] of lots) {
      const info = v.bases?.get(b)
      if (!info) { this.m.skipped.inc({ reason: 'lot_without_base' }, ns.size); continue }
      if (basesToIndex.has(b)) continue // deja relue en entier
      if (info.lotCount === undefined) await this.readManifest(v, b)
      for (const n of ns) await this.indexLot(v, handle, space, b, n, info.lotCount ?? BASE_LOT_COUNT, prio, origin)
    }
  }

  private fetch<T>(fn: () => Promise<T>): Promise<T> {
    return this.fetches.run(fn)
  }

  /** Un fichier (PDF, Word, image...) que lit un extracteur officiel. */
  private extractable(path: string): boolean {
    return !!this.opts.extractor && !isTrashPath(path) && !isNotePath(path) && !!this.opts.extractor(path)
  }

  /** Le texte d'un fichier, par son extracteur : une entree d'index comme une note. */
  private async extractFile(v: Vault, id: string, path: string, signal?: AbortSignal): Promise<NoteInput | null | undefined> {
    const spec = this.opts.extractor!(path)!
    const bytes = await this.fetch(() => this.backend.file(v.id, id, MAX_EXTRACT_BYTES, signal))
    if (!bytes) return undefined
    try {
      const content = await spec.extract(bytes, { path })
      return { id, path, content: extractedToMarkdown(content), frontmatter: true }
    } catch (err) {
      this.m.skipped.inc({ reason: 'extract' })
      this.log.warn('fichier illisible', { vault: v.id, doc: id, err })
      return undefined
    }
  }

  /** Lit des notes au backend puis les ecrit, en une transaction par lot de BUILD_BATCH. */
  private async writeNotes(v: Vault, handle: () => Promise<Handle>, all: { id: string; path: string }[], prio: Priority, origin: string, signal?: AbortSignal): Promise<void> {
    // Les fichiers d'abord, a part : leur extraction (OCR...) se fait hors transaction.
    const files = all.filter(it => this.extractable(it.path))
    const items = all.filter(it => !this.extractable(it.path))
    for (const f of files) {
      const input = await this.extractFile(v, f.id, f.path, signal)
      if (input === undefined) continue
      await this.slot.run(prio, async () => {
        const h = await handle()
        if (input) await h.index.applyDocs([input])
        this.m.docs.inc({ origin }, 1)
        v.lastWriteAt = Date.now()
      }, signal)
    }
    for (let i = 0; i < items.length; i += this.opts.buildBatch) {
      const slice = items.slice(i, i + this.opts.buildBatch)
      const logs = await mapLimit(slice, this.opts.fetchConcurrency, it => this.fetch(() => this.readDoc(v, it.id, signal)))
      await this.slot.run(prio, async () => {
        const h = await handle()
        const inputs: NoteInput[] = []
        const gone: string[] = []
        for (let k = 0; k < slice.length; k++) {
          const log = logs[k]
          if (log === null) { gone.push(slice[k]!.id); continue }
          if (log === undefined || log.format !== 'yjs') { this.m.skipped.inc({ reason: log ? 'format' : 'unreadable' }); continue }
          try {
            const input = noteInputFromUpdates(slice[k]!.id, slice[k]!.path, bytesOf(log))
            if (input) inputs.push(input)
          } catch (err) {
            this.m.skipped.inc({ reason: 'decode' })
            this.log.warn('document illisible', { vault: v.id, doc: slice[k]!.id, err })
          }
        }
        if (inputs.length) await h.index.applyDocs(inputs)
        if (gone.length) await h.index.removeDocs(gone)
        this.m.docs.inc({ origin }, inputs.length)
        if (gone.length) this.m.removed.inc({ origin }, gone.length)
        v.lastWriteAt = Date.now()
      }, signal)
    }
  }

  /** Journal d'un document ; null s'il est parti ; undefined s'il est illisible (trop gros...). */
  private async readDoc(v: Vault, docId: string, signal?: AbortSignal): Promise<UpdatesLog | null | undefined> {
    try {
      return await this.backend.document(v.id, docId, signal)
    } catch (err) {
      if (err instanceof BackendError && !err.transient) {
        this.m.skipped.inc({ reason: err.code })
        this.log.warn('document ignore', { vault: v.id, doc: docId, code: err.code, message: err.message })
        return undefined
      }
      throw err
    }
  }

  // ── Bases et lignes legeres ──────────────────────────────────────────────

  /** Oublie les signatures de lignes d'un vault (d'une base, si donnee). */
  private forgetLots(vaultId: string, baseId?: string): void {
    const prefix = `${vaultId}/`
    for (const k of [...this.lotSigs.keys()]) {
      if (!k.startsWith(prefix)) continue
      if (baseId === undefined || k.slice(prefix.length + 2).startsWith(`${baseId}~`)) this.lotSigs.delete(k)
    }
  }

  private async manifestOf(v: Vault, baseId: string, signal?: AbortSignal): Promise<BaseManifest | null> {
    const log = await this.fetch(() => this.readDoc(v, baseId, signal))
    return log && log.format === 'yjs' ? baseManifestFromUpdates(bytesOf(log)) : null
  }

  /** Nombre de lots d'une base (pour savoir quelles lignes un lot contient). */
  private async readManifest(v: Vault, baseId: string): Promise<void> {
    const m = await this.manifestOf(v, baseId)
    const info = v.bases?.get(baseId)
    if (info && m) { info.lotCount = m.lotCount; info.lots = m.lots }
  }

  /** Le document de la base a change : nouveaux lots, ou repartition changee (tout relire). */
  private async refreshBase(v: Vault, handle: () => Promise<Handle>, space: string, baseId: string, prio: Priority, origin: string): Promise<void> {
    const info = v.bases?.get(baseId)
    if (!info) return
    if (info.lotCount === undefined || !info.lots) return this.indexBase(v, handle, space, baseId, prio, origin)
    const m = await this.manifestOf(v, baseId)
    if (!m) return
    if (m.lotCount !== info.lotCount) return this.indexBase(v, handle, space, baseId, prio, origin)
    const known = new Set(info.lots)
    info.lots = m.lots
    for (const n of m.lots) if (!known.has(n)) await this.indexLot(v, handle, space, baseId, n, m.lotCount, prio, origin)
  }

  /** Relit une base en entier : manifeste, puis chaque lot. */
  private async indexBase(v: Vault, handle: () => Promise<Handle>, space: string, baseId: string, prio: Priority, origin: string, signal?: AbortSignal, info = v.bases?.get(baseId)): Promise<void> {
    const manifest = await this.manifestOf(v, baseId, signal)
    if (info) {
      info.lotCount = manifest?.lotCount
      info.lots = manifest?.lots
      info.checked = true
    }
    const present = new Set<string>()
    for (const n of manifest?.lots ?? []) {
      const ids = await this.indexLot(v, handle, space, baseId, n, manifest!.lotCount, prio, origin, signal, true)
      for (const id of ids) present.add(id)
    }
    await this.slot.run(prio, async () => {
      const h = await handle()
      const gone = (await h.index.rowIds(baseId)).filter(id => !present.has(id))
      for (let i = 0; i < gone.length; i += ROWS_PER_TX) await h.index.removeDocs(gone.slice(i, i + ROWS_PER_TX))
      if (gone.length) this.m.removed.inc({ origin }, gone.length)
    }, signal)
  }

  /**
   * Relit un lot : ses lignes sont ecrites (seulement celles qui ont change
   * si on connait deja le lot), celles qui en sont parties retirees. Rend
   * les ids des lignes du lot.
   */
  private async indexLot(v: Vault, handle: () => Promise<Handle>, space: string, baseId: string, n: number, lotCount: number, prio: Priority, origin: string, signal?: AbortSignal, full = false): Promise<string[]> {
    const docId = lotDocId(baseId, n)
    const log = await this.fetch(() => this.readDoc(v, docId, signal))
    if (log === undefined) return []
    // Signatures par index (celui qui repond, ou celui qu'on construit a cote).
    const key = `${v.id}/${space}/${docId}`
    const rows = log && log.format === 'yjs' ? lotRowsFromUpdates(bytesOf(log)) : []
    const before = full ? undefined : this.lotSigs.get(key)
    const sigs = new Map<string, string>()
    const records: NoteRecord[] = []
    for (const r of rows) {
      const sig = JSON.stringify([r.title, r.values])
      sigs.set(r.id, sig)
      if (before?.get(r.id) !== sig) records.push(lightRowRecord(baseId, r, v.schema))
    }
    for (let i = 0; i < records.length || i === 0; i += ROWS_PER_TX) {
      const chunk = records.slice(i, i + ROWS_PER_TX)
      const last = i + ROWS_PER_TX >= records.length
      await this.slot.run(prio, async () => {
        const h = await handle()
        if (chunk.length) await h.index.applyRecords(chunk)
        if (last && !full) {
          // Lignes parties du lot (supprimees) : celles de l'index qui tombent dans ce lot et n'y sont plus.
          const gone = before
            ? [...before.keys()].filter(id => !sigs.has(id))
            : (await h.index.rowIds(baseId)).filter(id => baseLotOf(id, lotCount) === n && !sigs.has(id))
          if (gone.length) {
            await h.index.removeDocs(gone)
            this.m.removed.inc({ origin }, gone.length)
          }
        }
      }, signal)
      if (last) break
    }
    this.m.docs.inc({ origin: origin + '_rows' }, records.length)
    this.lotSigs.delete(key)
    this.lotSigs.set(key, sigs)
    while (this.lotSigs.size > LOT_SIG_CACHE) this.lotSigs.delete(this.lotSigs.keys().next().value as string)
    return [...sigs.keys()]
  }

  // ── Constructions ────────────────────────────────────────────────────────

  private enqueueBuild(v: Vault): void {
    if (!v.owned || v.building || this.stopping) return
    if (v.queued) {
      if (v.demanded) {
        const i = this.buildQueue.indexOf(v)
        if (i > 0) { this.buildQueue.splice(i, 1); this.buildQueue.unshift(v) }
      }
      return
    }
    v.queued = true
    if (v.demanded) this.buildQueue.unshift(v)
    else this.buildQueue.push(v)
  }

  private pumpBuilds(): void {
    if (this.stopping) return
    const now = Date.now()
    while (this.building.size < this.opts.buildConcurrency) {
      const i = this.buildQueue.findIndex(v => v.retryAt <= now)
      if (i < 0) break
      const v = this.buildQueue.splice(i, 1)[0]!
      v.queued = false
      if (!v.owned || !v.rebuild || v.building) continue
      this.building.add(v)
      v.building = true
      this.track(this.build(v).finally(() => {
        v.building = false
        v.demanded = false
        this.building.delete(v)
        this.pumpBuilds()
        this.schedule()
      }), 'build', v.id)
    }
    // Un vault en attente de nouvel essai : on repassera.
    const waiting = this.buildQueue.filter(v => v.retryAt > now)
    if (waiting.length && this.building.size < this.opts.buildConcurrency) {
      const at = Math.min(...waiting.map(v => v.retryAt))
      setTimeout(() => this.pumpBuilds(), Math.max(10, at - now)).unref()
    }
  }

  private async build(v: Vault): Promise<void> {
    const reason = v.rebuild!
    const inPlace = IN_PLACE.has(reason)
    const abort = new AbortController()
    v.buildAbort = abort
    const signal = abort.signal
    const t0 = performance.now()
    // Tout changement deja distribue est couvert par ce qu'on va lire.
    const from = this.feedPos
    for (const [id, p] of v.docs) if (p.seq <= from) v.docs.delete(id)
    if (v.tree && v.tree.seq <= from) v.tree = undefined
    v.progress = 0
    this.forgetLots(v.id)
    const buildingFile = v.file + '.building'
    this.log.info('construction', { vault: v.id, reason, mode: inPlace ? 'en place' : 'a cote' })
    try {
      // Types du vault : les valeurs sont typees comme chez les clients.
      v.typesDirty = false
      await this.loadSchema(v, signal)
      const typesKey = v.schemaKey ?? ''
      if (!inPlace) {
        v.replay = { docs: new Set(), tree: false }
        await this.slot.run(BUILD, async () => {
          this.rmIndex(buildingFile)
          const h = await this.openHandle(buildingFile, this.powers(), v.schema)
          h.off = h.index.onChange(() => this.bump(v))
          v.target = h
          if (v.serving) this.refreshState(v, v.serving)
        }, signal)
      } else {
        await this.slot.run(BUILD, async () => { this.refreshState(v, v.serving ?? await this.openServing(v)) }, signal)
      }
      const handle = async () => {
        const h = inPlace ? (v.serving ?? await this.openServing(v)) : v.target
        if (!h) throw new Error('index cible ferme')
        v.lastUsed = Date.now()
        return h
      }
      const treeAt = Date.now()
      const log = await this.fetch(() => this.backend.tree(v.id, signal))
      if (!log) throw new BackendError(404, 'not_found', 'Vault inconnu du backend (ou plus servi par le pair gere).', false)
      const tree = vaultTreeFromUpdates(bytesOf(log))
      // En place : un changement vu avant cette lecture y est deja (il attendait la fin de la construction).
      if (inPlace && v.tree && v.tree.lastAt < treeAt) v.tree = undefined
      const notes: { id: string; path: string }[] = []
      const bases = new Map<string, BaseInfo>()
      for (const [id, path] of tree.docs) {
        if (isNotePath(path)) notes.push({ id, path })
        else if (isBasePath(path)) bases.set(id, { path, checked: false })
      }
      const total = notes.length + bases.size
      let done = 0
      const progress = async () => {
        v.progress = total ? done / total : 1
        await this.slot.run(BUILD, async () => {
          const h = await handle()
          this.refreshState(v, h)
          if (!inPlace && v.serving) this.refreshState(v, v.serving)
        }, signal)
      }

      // Notes, par lots ; le lot suivant se lit pendant que celui-ci s'ecrit.
      const batch = this.opts.buildBatch
      const read = (i: number) => {
        const at = Date.now()
        return mapLimit(notes.slice(i, i + batch), this.opts.fetchConcurrency, it => this.fetch(() => this.readDoc(v, it.id, signal)))
          .then(logs => ({ logs, at }))
      }
      let next = notes.length ? read(0) : undefined
      for (let i = 0; i < notes.length; i += batch) {
        const { logs, at } = await next!
        next = i + batch < notes.length ? read(i + batch) : undefined
        next?.catch(() => undefined)
        const slice = notes.slice(i, i + batch)
        await this.slot.run(BUILD, async () => {
          const h = await handle()
          const inputs: NoteInput[] = []
          const gone: string[] = []
          for (let k = 0; k < slice.length; k++) {
            const l = logs[k]
            if (l === null) { gone.push(slice[k]!.id); continue }
            if (l === undefined || l.format !== 'yjs') { this.m.skipped.inc({ reason: l ? 'format' : 'unreadable' }); continue }
            try {
              const input = noteInputFromUpdates(slice[k]!.id, slice[k]!.path, bytesOf(l))
              if (input) inputs.push(input)
            } catch (err) {
              this.m.skipped.inc({ reason: 'decode' })
              this.log.warn('document illisible', { vault: v.id, doc: slice[k]!.id, err })
            }
          }
          if (inputs.length) await h.index.applyDocs(inputs)
          if (gone.length) await h.index.removeDocs(gone)
          this.m.docs.inc({ origin: 'build' }, inputs.length)
          if (inPlace) {
            // Changements vus avant la lecture de ces notes : deja dedans.
            for (const it of slice) { const p = v.docs.get(it.id); if (p && p.lastAt < at) v.docs.delete(it.id) }
            if (!v.pendingCount) this.pendingVaults.delete(v)
          }
        }, signal)
        done += slice.length
        await progress()
      }

      // Bases : chaque lot de lignes legeres.
      const space = inPlace ? 'S' : 'T'
      for (const [b, info] of bases) {
        await this.indexBase(v, handle, space, b, BUILD, 'build', signal, info)
        done++
        await progress()
      }

      // Ce qui est indexe mais n'est plus dans l'arbre.
      await this.slot.run(BUILD, async () => {
        const h = await handle()
        const ids = new Set(notes.map(n => n.id))
        const gone = [...(await h.index.paths()).keys()].filter(id => !ids.has(id))
        if (gone.length) await h.index.removeDocs(gone)
        for (const b of await h.index.bases()) {
          if (bases.has(b)) continue
          const rows = await h.index.rowIds(b)
          for (let i = 0; i < rows.length; i += ROWS_PER_TX) await h.index.removeDocs(rows.slice(i, i + ROWS_PER_TX))
        }
      }, signal)

      if (!inPlace) {
        // Rejouer sur le nouvel index ce que le flux a change pendant la construction.
        for (let round = 0; round < 5; round++) {
          const r = v.replay!
          if (!r.docs.size && !r.tree) break
          v.replay = { docs: new Set(), tree: false }
          await this.process(v, 'target', [...r.docs], r.tree, BUILD, 'replay')
        }
      }

      // Bascule (a cote) ou fin (en place), sans unite au fil de l'eau en cours.
      await v.unit.run(async () => {
        if (signal.aborted) throw signal.reason
        if (!inPlace && v.replay && (v.replay.docs.size || v.replay.tree)) {
          const r = v.replay
          v.replay = { docs: new Set(), tree: false }
          await this.process(v, 'target', [...r.docs], r.tree, BUILD, 'replay')
        }
        const seq = this.lowWaterOf(v, from)
        await this.slot.run(BUILD, async () => {
          const h = await handle()
          await h.index.setSeq(seq)
          await h.index.setHostMeta({ epoch: this.epoch ?? '', builtAt: new Date().toISOString(), types: typesKey })
          await h.index.markBuilt()
          if (!inPlace) {
            await this.closeHandle(v, 'serving')
            await this.closeHandle(v, 'target')
            for (const s of SUFFIXES.slice(1)) this.rm(v.file + s)
            renameSync(buildingFile, v.file)
            this.rmIndex(buildingFile)
          }
          this.rm(this.staleFile(v))
          v.bases = bases
          if (!inPlace) this.forgetLots(v.id)
          v.rebuild = undefined
          v.replay = undefined
          v.progress = undefined
          v.appliedSeq = seq
          v.failures = 0
          if (!inPlace) await this.openServing(v)
          else this.refreshState(v, h)
          this.bump(v)
        })
      })
      const seconds = (performance.now() - t0) / 1000
      this.m.builds.inc({ mode: inPlace ? 'in_place' : 'beside', result: 'ok' })
      this.m.buildSeconds.observe({ mode: inPlace ? 'in_place' : 'beside' }, seconds)
      this.log.info('construction terminee', { vault: v.id, reason, notes: notes.length, bases: bases.size, seconds: Math.round(seconds * 10) / 10 })
      await this.refreshStats(v)
      // Types changes pendant la construction : on recommence avec les bons.
      if (v.typesDirty || (v.schemaKey ?? '') !== typesKey) {
        v.typesDirty = false
        v.rebuild = 'types'
        this.enqueueBuild(v)
        this.pumpBuilds()
      }
    } catch (err) {
      v.progress = v.rebuild ? v.progress : undefined
      if (!inPlace) {
        // L'ancien index continue de repondre ; le nouveau sera refait.
        await this.slot.run(LIVE, async () => { await this.closeHandle(v, 'target') }).catch(() => undefined)
        this.rmIndex(buildingFile)
        v.replay = undefined
      }
      if (this.stopping || !v.owned) return
      this.m.builds.inc({ mode: inPlace ? 'in_place' : 'beside', result: 'error' })
      v.failures++
      const wait = Math.min(600_000, 5000 * 2 ** Math.min(7, v.failures - 1))
      v.retryAt = Date.now() + wait
      this.log.warn('construction echouee, nouvel essai plus tard', { vault: v.id, reason, retryInMs: wait, err })
      this.enqueueBuild(v)
    } finally {
      v.buildAbort = undefined
    }
  }

  // ── Orphelins, suppressions ──────────────────────────────────────────────

  private async orphan(v: Vault): Promise<void> {
    v.owned = false
    v.buildAbort?.abort(new Error('orphelin'))
    v.docs.clear()
    v.tree = undefined
    this.pendingVaults.delete(v)
    this.forgetLots(v.id)
    await v.unit.run(async () => {
      await this.slot.run(LIVE, async () => {
        await this.closeHandle(v, 'serving')
        await this.closeHandle(v, 'target')
      })
      this.rmIndex(v.file + '.building')
      if (v.orphanSince === undefined) v.orphanSince = this.readStale(v) ?? Date.now()
      if (existsSync(v.file)) writeFileSync(this.staleFile(v), JSON.stringify({ since: v.orphanSince }))
      v.rebuild = undefined
      v.checked = false
      v.bases = undefined
      this.bump(v)
    })
    this.log.info('vault orphelin : index garde jusqu a ORPHAN_TTL', { vault: v.id })
  }

  private async deleteVault(v: Vault, why: string): Promise<void> {
    v.owned = false
    v.buildAbort?.abort(new Error('supprime'))
    v.docs.clear()
    v.tree = undefined
    this.pendingVaults.delete(v)
    await v.unit.run(async () => {
      await this.slot.run(LIVE, async () => {
        await this.closeHandle(v, 'serving')
        await this.closeHandle(v, 'target')
      })
      this.rmIndex(v.file)
      this.rmIndex(v.file + '.building')
      this.rm(this.staleFile(v))
      v.orphanSince = undefined
      v.rebuild = undefined
      v.checked = false
      v.appliedSeq = 0
      v.maxSeen = 0
      v.bases = undefined
      this.bump(v)
    })
    this.forgetLots(v.id)
    // Revenu entre-temps (vault-deleted puis vault : retour au pair gere) : on le reconstruit.
    if (v.owned) { this.enqueueCheck(v); this.pumpChecks() } else this.vaults.delete(v.id)
    this.m.deleted.inc({ reason: why })
    this.log.info('index supprime', { vault: v.id, reason: why })
  }

  private sweep(): void {
    const now = Date.now()
    for (const v of [...this.vaults.values()]) {
      if (v.owned || v.orphanSince === undefined) continue
      if (now - v.orphanSince >= this.opts.orphanTtlMs) this.track(this.deleteVault(v, 'orphan'), 'delete', v.id)
    }
    // Statistiques des vaults ouverts qui ont change.
    for (const v of this.vaults.values()) {
      if (v.owned && v.serving && v.stats.dirty && now - v.stats.at >= this.opts.statsIntervalMs) this.track(this.refreshStats(v), 'stats', v.id)
    }
  }

  private fileBytes(file: string): number {
    let n = 0
    for (const s of ['', '-wal']) {
      try { n += statSync(file + s).size } catch { /* absent */ }
    }
    return n
  }

  private async refreshStats(v: Vault): Promise<void> {
    await this.slot.run(LIVE, async () => {
      if (!v.serving) return
      const st = await v.serving.index.call('index', 'status', {}) as IndexStatus
      v.stats = { docs: st.docs, bytes: this.fileBytes(v.file), at: Date.now(), dirty: false }
    })
  }

  // ── Observabilite ────────────────────────────────────────────────────────

  snapshot(): StoreSnapshot {
    const now = Date.now()
    const vaults: VaultSnapshot[] = []
    const byStatus = new Map<string, number>()
    for (const v of this.vaults.values()) {
      const st = v.owned ? this.stateOf(v, now) : { status: 'unavailable' as const }
      const oldest = v.oldestPending()
      const lagMs = Math.max(oldest !== undefined ? now - oldest : 0, now - this.polledAt > this.opts.feedStaleMs ? now - this.polledAt : 0)
      const key = v.owned ? st.status : 'orphan'
      byStatus.set(key, (byStatus.get(key) ?? 0) + 1)
      vaults.push({
        id: v.id, status: st.status, ...(st.progress !== undefined ? { progress: st.progress } : {}), lagMs,
        ...(v.rebuild ? { rebuild: v.rebuild } : {}), pending: v.pendingCount, docs: v.stats.docs,
        bytes: v.stats.bytes || this.fileBytes(v.file), seq: v.appliedSeq, open: !!v.serving, orphan: !v.owned,
      })
    }
    const shard = { shard: this.opts.shard }
    const families: Family[] = [
      this.m.changes.family(), this.m.docs.family(), this.m.removed.family(), this.m.skipped.family(),
      this.m.builds.family(), this.m.live.family(), this.m.errors.family(), this.m.calls.family(),
      this.m.backendRequests.family(), this.m.evictions.family(), this.m.deleted.family(),
      ...this.m.buildSeconds.families('savoire_indexer_build_duration_quantile_seconds', 'Duree des constructions (quantiles, 5 dernieres minutes).'),
      ...this.m.backendSeconds.families('savoire_indexer_backend_request_latency_seconds', 'Latence des appels au backend (quantiles, 5 dernieres minutes).'),
      gauge('savoire_indexer_slot_busy_seconds_total', 'Temps passe dans le creneau SQLite, par priorite.',
        PRIORITY_NAMES.map((p, i) => ({ labels: { priority: p }, value: this.slot.busyMs[i]! / 1000 }))),
      gauge('savoire_indexer_vaults', 'Vaults par etat.', [...byStatus].map(([state, n]) => ({ labels: { state }, value: n }))),
    ]
    for (const f of families) for (const s of f.samples) s.labels = { ...s.labels, ...shard }
    return {
      shard: this.opts.shard,
      families,
      vaults,
      queue: { interactive: this.slot.depth(INTERACTIVE), live: this.slot.depth(LIVE), build: this.slot.depth(BUILD) },
      open: this.openCount,
      building: this.building.size,
      buildQueued: this.buildQueue.length,
    }
  }
}

function merge(p: Pending | undefined, seq: number, now: number): Pending {
  return p ? { seq: Math.max(p.seq, seq), firstAt: p.firstAt, lastAt: now } : { seq, firstAt: now, lastAt: now }
}

function round(x: number): number {
  return Math.round(x * 1000) / 1000
}

export { HttpError }
