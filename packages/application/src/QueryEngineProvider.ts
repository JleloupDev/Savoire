// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Fournisseur du moteur de requetes de l'appli : c'est lui que les plugins
// recoivent en `api.query`. Voir ADR-027.
//
// Aujourd'hui, un moteur LOCAL en memoire (InMemoryQueryEngine, injecte par
// l'appli), alimente par :
//  - le canal d'index partage 'metadata' (le frontmatter de chaque note,
//    publie par MetadataIndexContributor) et l'arborescence du vault
//    (chemins, corbeille, notes pas encore indexees) ;
//  - les types des proprietes du vault : une valeur est typee avant d'entrer ;
//  - les lots de lignes legeres des bases interrogees, ouverts a la demande.
// C'est aussi le futur mode degrade. Les moteurs suivants (pair indexeur
// distant, SQLite local) se branchent par setPreferred() : ils repondent
// d'abord, et le moteur local reprend quand ils sont indisponibles.
//
// Une requete sur un dossier fait indexer les notes de ce dossier qui ne
// l'ont jamais ete (lues hors editeur, en petit nombre) : l'etat de l'index
// passe alors en construction, avec sa progression.
import { BASE_LOT_COUNT, BASE_ROW_PREFIX, BASE_ROW_TITLE, baseLotName, coercePropertyValue, guessPropertyType } from '@savoire/plugin-api'
import type {
  IndexState, IPropertyTypes, IQueryEngine, ISharedTree, ITreeMap, PropertyValue, Query, QueryResult,
  TreeChange, TreeNode, TreeValue,
} from '@savoire/plugin-api'
import type { DocMetadata } from '@savoire/domain-index'
import { isAttachmentPath } from '@savoire/platform'
import type { IVaultSyncSession } from './contracts'
import type { ITreeSource } from './SessionTrees'

/** Une note ou une ligne legere, telle que le moteur local la range (IndexedDoc). */
export interface LocalIndexedDoc {
  id: string
  path: string
  title: string
  base?: string
  props: Record<string, PropertyValue>
  text?: string
}

/** Ce que le fournisseur attend du moteur local (InMemoryQueryEngine de plugin-runtime). */
export interface ILocalQueryEngine extends IQueryEngine {
  upsert(doc: LocalIndexedDoc): void
  remove(id: string): void
  batch(fn: () => void): void
  setState(state: IndexState): void
}

export interface QueryVaultSources {
  session: IVaultSyncSession
  /** Metadonnees partagees des notes (canal 'metadata'), et leurs changements. */
  metadata: { getAll(): DocMetadata[]; onChange(cb: () => void): () => void }
  /** Types des proprietes du vault. */
  types?: IPropertyTypes
  /** Indexe une note lue hors editeur (ContentIndexingService.indexNow). Sans lui, pas de rattrapage. */
  indexNow?: (docId: string, path: string, markdown: string) => Promise<void>
  /** Arbres des bases et de leurs lots. Sans lui, pas de lignes legeres. */
  trees?: ITreeSource
}

export interface QueryEngineProviderOptions {
  /** Notes rattrapees au plus par dossier interroge. Defaut : 500. */
  backfillLimit?: number
  /** Lectures de notes en parallele. Defaut : 3. */
  backfillConcurrency?: number
  /** Une base non interrogee depuis ce delai libere ses lots (les lignes restent). Defaut : 60 s. */
  baseIdleMs?: number
}

interface LotState {
  tree: ISharedTree
  unsub: () => void
  rows: Set<string>
  keyOf: WeakMap<TreeNode, string>
}

interface BaseState {
  baseId: string
  tree?: ISharedTree
  unsub?: () => void
  lots: Map<number, LotState>
  opening: Set<number>
  lotCount: number
  lastUsed: number
  watchers: number
  live: boolean
}

interface WatchEntry {
  query: Query
  cb: (r: QueryResult) => void
  stop: () => void
}

function stemOf(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1)
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(0, dot) : name
}

function extOf(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1)
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
}

/** Une valeur ancienne de l'index (chaine entre guillemets) : on retire les guillemets. */
function normalizeValue(v: unknown): PropertyValue {
  if (v === null || v === undefined) return null
  if (typeof v === 'string') {
    const q = /^(["'])(.*)\1$/.exec(v)
    return q ? q[2] : v
  }
  if (typeof v === 'number' || typeof v === 'boolean') return v
  if (Array.isArray(v)) return v.filter(x => x !== null && x !== undefined).map(x => String(normalizeValue(x)))
  return null
}

function isMap(v: TreeValue | undefined): v is ITreeMap {
  return typeof v === 'object' && v !== null && v.kind === 'map'
}

export class QueryEngineProvider implements IQueryEngine {
  private local: ILocalQueryEngine
  private preferred: IQueryEngine | null = null
  private sources: QueryVaultSources | null = null
  private unsubs: (() => void)[] = []
  private readonly sigs = new Map<string, string>()
  private syncTimer: ReturnType<typeof setTimeout> | null = null
  private readonly watches = new Set<WatchEntry>()
  private readonly stateListeners = new Set<(s: IndexState) => void>()
  private readonly bases = new Map<string, BaseState>()
  private idleTimer: ReturnType<typeof setInterval> | null = null
  // Rattrapage des notes jamais indexees.
  private readonly tried = new Set<string>()
  private readonly queue: { id: string; path: string }[] = []
  private running = 0
  // Travaux en cours (rattrapage, lots) : pour la progression.
  private total = 0
  private done = 0
  private readonly idleWaiters: (() => void)[] = []

  constructor(
    private readonly createLocal: () => ILocalQueryEngine,
    private readonly options: QueryEngineProviderOptions = {},
  ) {
    this.local = createLocal()
  }

  // ── Branchement ───────────────────────────────────────────────────────────

  /** Rebranche tout sur un vault (ou sur rien). Le moteur local repart de zero. */
  attachVault(sources: QueryVaultSources | undefined): void {
    this.detach()
    this.local = this.createLocal()
    this.sources = sources ?? null
    this.resubscribeWatches()
    if (!sources) return
    const schedule = () => this.scheduleSync()
    this.unsubs.push(sources.metadata.onChange(schedule))
    this.unsubs.push(sources.session.directory.onChange(schedule))
    if (sources.types) {
      this.unsubs.push(sources.types.onChange(() => {
        // Un type change : toutes les valeurs sont a retyper.
        this.sigs.clear()
        this.scheduleSync()
        for (const base of this.bases.values()) for (const lot of base.lots.values()) this.readLot(base.baseId, lot)
      }))
    }
    this.syncNotes()
    this.idleTimer = setInterval(() => this.releaseIdleBases(), 15_000)
  }

  /**
   * Moteur prefere (pair indexeur, SQLite local) : interroge d'abord. S'il
   * rejette avec `unavailable`, le moteur local repond. Null : le local seul.
   */
  setPreferred(engine: IQueryEngine | null): void {
    this.preferred = engine
    this.resubscribeWatches()
    this.emitState()
  }

  /** Resolu quand le rattrapage et les lots en cours sont termines (tests, outils). */
  whenIdle(): Promise<void> {
    if (this.total === this.done) return Promise.resolve()
    return new Promise(r => this.idleWaiters.push(r))
  }

  dispose(): void {
    this.detach()
    this.watches.clear()
    this.stateListeners.clear()
  }

  // ── IQueryEngine ─────────────────────────────────────────────────────────

  async query(query: Query, options?: { signal?: AbortSignal }): Promise<QueryResult> {
    this.prepare(query)
    if (this.preferred) {
      try {
        return await this.preferred.query(query, options)
      } catch (err) {
        if ((err as { code?: string })?.code !== 'unavailable') throw err
      }
    }
    return this.local.query(query, options)
  }

  watch(query: Query, cb: (result: QueryResult) => void): () => void {
    const entry: WatchEntry = { query, cb, stop: () => {} }
    this.watches.add(entry)
    this.prepare(query)
    // Une base regardee garde ses lots ouverts.
    const st = query.from && 'base' in query.from ? this.bases.get(query.from.base) : undefined
    if (st) st.watchers++
    entry.stop = this.engine().watch(query, cb)
    return () => {
      entry.stop()
      this.watches.delete(entry)
      if (st) { st.watchers--; st.lastUsed = Date.now() }
    }
  }

  state(): IndexState {
    return this.engine().state()
  }

  onStateChange(cb: (state: IndexState) => void): () => void {
    this.stateListeners.add(cb)
    return () => { this.stateListeners.delete(cb) }
  }

  // ── Interne : moteurs ─────────────────────────────────────────────────────

  private engine(): IQueryEngine {
    const p = this.preferred
    return p && p.state().status !== 'unavailable' ? p : this.local
  }

  private resubscribeWatches(): void {
    for (const w of this.watches) {
      w.stop()
      w.stop = this.engine().watch(w.query, w.cb)
    }
  }

  private detach(): void {
    for (const u of this.unsubs) u()
    this.unsubs = []
    if (this.syncTimer) { clearTimeout(this.syncTimer); this.syncTimer = null }
    if (this.idleTimer) { clearInterval(this.idleTimer); this.idleTimer = null }
    for (const base of this.bases.values()) this.closeBase(base)
    this.bases.clear()
    this.sigs.clear()
    this.tried.clear()
    this.queue.length = 0
    this.total = 0
    this.done = 0
    this.sources = null
    this.flushIdle()
  }

  // ── Notes ─────────────────────────────────────────────────────────────────

  private scheduleSync(): void {
    if (this.syncTimer) return
    this.syncTimer = setTimeout(() => {
      this.syncTimer = null
      this.syncNotes()
    }, 30)
  }

  private typeProps(values: Record<string, unknown>): Record<string, PropertyValue> {
    const types = this.sources?.types
    const props: Record<string, PropertyValue> = {}
    for (const [key, raw] of Object.entries(values)) {
      const v = normalizeValue(raw)
      props[key] = coercePropertyValue(v, types?.get(key)?.type ?? guessPropertyType(v))
    }
    return props
  }

  /** Les notes du vault -> le moteur local. Seules celles qui ont change y entrent. */
  private syncNotes(): void {
    const sources = this.sources
    if (!sources) return
    const metas = new Map<string, DocMetadata>()
    for (const m of sources.metadata.getAll()) metas.set(m.docId, m)
    const seen = new Set<string>()
    const engine = this.local
    engine.batch(() => {
      for (const d of sources.session.directory.getAll()) {
        if (isAttachmentPath(d.path)) continue
        seen.add(d.id)
        const meta = metas.get(d.id)
        const doc: LocalIndexedDoc = {
          id: d.id,
          path: d.path,
          title: stemOf(d.path),
          props: meta ? this.typeProps(meta.frontmatter ?? {}) : {},
        }
        const sig = JSON.stringify([doc.path, doc.props])
        if (this.sigs.get(d.id) === sig) continue
        this.sigs.set(d.id, sig)
        engine.upsert(doc)
      }
      for (const id of [...this.sigs.keys()]) {
        if (seen.has(id)) continue
        this.sigs.delete(id)
        engine.remove(id)
      }
    })
  }

  /** Prepare ce dont la requete a besoin : notes du dossier a rattraper, lots d'une base. */
  private prepare(query: Query): void {
    const from = query.from
    if (!from) return
    if ('notes' in from) this.backfill(from.folder, from.ext)
    else if ('base' in from && from.base) {
      if (from.pages) this.backfill(from.pages.folder, from.pages.ext)
      this.ensureBase(from.base)
    }
  }

  /**
   * Notes d'un dossier qui n'ont jamais ete indexees (jamais ouvertes nulle
   * part) : lues hors editeur et publiees dans l'index partage, au plus
   * backfillLimit. Pas de rattrapage sur tout le vault : un client web ne
   * telecharge pas 10 000 notes (ADR-027).
   */
  private backfill(folder: string | undefined, ext: string[] | undefined): void {
    const sources = this.sources
    if (!sources?.indexNow || !folder) return
    const prefix = folder.replace(/\/+$/, '') + '/'
    const exts = (ext ?? ['md']).map(e => e.toLowerCase().replace(/^\./, ''))
    if (!exts.includes('md')) return
    const indexed = new Set(sources.metadata.getAll().map(m => m.docId))
    const limit = this.options.backfillLimit ?? 500
    let added = 0
    for (const d of sources.session.directory.getAll()) {
      if (added >= limit) break
      if (!d.path.startsWith(prefix) || extOf(d.path) !== 'md') continue
      if (indexed.has(d.id) || this.tried.has(d.id)) continue
      this.tried.add(d.id)
      this.queue.push({ id: d.id, path: d.path })
      added++
    }
    if (added === 0) return
    this.addWork(added)
    this.pump()
  }

  private pump(): void {
    const sources = this.sources
    const max = this.options.backfillConcurrency ?? 3
    while (sources?.indexNow && this.running < max && this.queue.length > 0) {
      const job = this.queue.shift()!
      this.running++
      void (async () => {
        try {
          const markdown = await sources.session.readDocument(job.id, 'crdt')
          // Indexee entre-temps (ouverte, ou ecrite par une base) : son entree est plus fraiche.
          const indexed = sources.metadata.getAll().some(m => m.docId === job.id)
          if (this.sources === sources && !indexed) await sources.indexNow!(job.id, job.path, markdown)
        } catch (err) {
          console.warn('[QueryEngineProvider] note non indexee', job.path, err)
        } finally {
          this.running--
          if (this.sources === sources) {
            this.workDone(1)
            this.pump()
          }
        }
      })()
    }
  }

  // ── Bases et lignes legeres ─────────────────────────────────────────────

  private ensureBase(baseId: string): void {
    const trees = this.sources?.trees
    let st = this.bases.get(baseId)
    if (st) {
      st.lastUsed = Date.now()
      if (st.live || !trees) return
    }
    if (!trees) return
    if (!st) {
      st = { baseId, lots: new Map(), opening: new Set(), lotCount: BASE_LOT_COUNT, lastUsed: Date.now(), watchers: 0, live: false }
      this.bases.set(baseId, st)
    }
    st.live = true
    const base = st
    const sources = this.sources
    this.addWork(1)
    void trees.open(baseId).then(tree => {
      if (this.sources !== sources || !base.live) { trees.close(baseId); return }
      base.tree = tree
      // Le manifeste arrive apres l'ouverture (changements distants) : on
      // relit la liste des lots a chaque changement.
      base.unsub = tree.onChange(() => this.openLots(base))
      this.openLots(base)
    }).catch(err => {
      console.warn('[QueryEngineProvider] base illisible', baseId, err)
    }).finally(() => {
      if (this.sources === sources) this.workDone(1)
    })
  }

  private openLots(base: BaseState): void {
    const trees = this.sources?.trees
    const manifest = base.tree?.root.get('base')
    if (!trees || !isMap(manifest)) return
    const count = manifest.get('lotCount')
    if (typeof count === 'number' && count > 0) base.lotCount = count
    const lots = manifest.get('lots')
    if (!isMap(lots)) return
    const sources = this.sources
    for (const key of lots.keys()) {
      const n = Number(key)
      if (!Number.isInteger(n) || base.lots.has(n) || base.opening.has(n)) continue
      base.opening.add(n)
      this.addWork(1)
      void trees.openAnnex(base.baseId, baseLotName(n)).then(tree => {
        base.opening.delete(n)
        if (this.sources !== sources || !base.live) { trees.closeAnnex(base.baseId, baseLotName(n)); return }
        const lot: LotState = { tree, unsub: () => {}, rows: new Set(), keyOf: new WeakMap() }
        lot.unsub = tree.onChange(changes => this.applyLotChanges(base.baseId, lot, changes))
        base.lots.set(n, lot)
        this.readLot(base.baseId, lot)
      }).catch(err => {
        base.opening.delete(n)
        console.warn('[QueryEngineProvider] lot illisible', base.baseId, n, err)
      }).finally(() => {
        if (this.sources === sources) this.workDone(1)
      })
    }
  }

  private rowDoc(baseId: string, rowId: string, row: ITreeMap): LocalIndexedDoc {
    const values: Record<string, unknown> = {}
    let title = ''
    for (const key of row.keys()) {
      const v = row.get(key)
      const plain = typeof v === 'object' && v !== null ? (v.kind === 'list' ? v.toJSON() : v.kind === 'text' ? v.toString() : null) : v
      if (key === BASE_ROW_TITLE) { title = plain === null || plain === undefined ? '' : String(plain); continue }
      values[key] = plain
    }
    return { id: rowId, base: baseId, path: '', title, props: this.typeProps(values) }
  }

  /** Relit tout un lot (ouverture, retypage). */
  private readLot(baseId: string, lot: LotState): void {
    const root = lot.tree.root
    const engine = this.local
    engine.batch(() => {
      const present = new Set<string>()
      for (const key of root.keys()) {
        if (!key.startsWith(BASE_ROW_PREFIX)) continue
        const row = root.get(key)
        if (!isMap(row)) continue
        const id = key.slice(BASE_ROW_PREFIX.length)
        lot.keyOf.set(row, key)
        present.add(id)
        engine.upsert(this.rowDoc(baseId, id, row))
      }
      for (const id of lot.rows) if (!present.has(id)) engine.remove(id)
      lot.rows = present
    })
  }

  /** Un lot a change : seules les lignes touchees sont relues. */
  private applyLotChanges(baseId: string, lot: LotState, changes: TreeChange[]): void {
    const root = lot.tree.root
    const touched = new Set<string>()
    for (const c of changes) {
      if (c.target === root && c.kind === 'map') {
        for (const key of c.keys) if (key.startsWith(BASE_ROW_PREFIX)) touched.add(key)
        continue
      }
      let node: TreeNode | null = c.target
      while (node && node.parent && node.parent !== root) node = node.parent
      const key = node ? lot.keyOf.get(node) : undefined
      if (key) touched.add(key)
    }
    if (touched.size === 0) return
    const engine = this.local
    engine.batch(() => {
      for (const key of touched) {
        const id = key.slice(BASE_ROW_PREFIX.length)
        const row = root.get(key)
        if (isMap(row)) {
          lot.keyOf.set(row, key)
          lot.rows.add(id)
          engine.upsert(this.rowDoc(baseId, id, row))
        } else {
          lot.rows.delete(id)
          engine.remove(id)
        }
      }
    })
  }

  private closeBase(base: BaseState): void {
    const trees = this.sources?.trees
    base.live = false
    base.unsub?.()
    base.unsub = undefined
    for (const [n, lot] of base.lots) {
      lot.unsub()
      trees?.closeAnnex(base.baseId, baseLotName(n))
    }
    base.lots.clear()
    if (base.tree) trees?.close(base.baseId)
    base.tree = undefined
  }

  /** Une base que personne ne regarde libere ses documents ; ses lignes restent dans l'index. */
  private releaseIdleBases(): void {
    const idle = this.options.baseIdleMs ?? 60_000
    const now = Date.now()
    for (const base of this.bases.values()) {
      if (base.live && base.watchers <= 0 && now - base.lastUsed > idle) this.closeBase(base)
    }
  }

  // ── Etat de l'index ─────────────────────────────────────────────────────

  private addWork(n: number): void {
    this.total += n
    this.publishState()
  }

  private workDone(n: number): void {
    this.done += n
    if (this.done >= this.total) { this.done = 0; this.total = 0 }
    this.publishState()
    if (this.total === 0) this.flushIdle()
  }

  private flushIdle(): void {
    for (const r of this.idleWaiters.splice(0)) r()
  }

  private publishState(): void {
    const state: IndexState = this.total > 0
      ? { status: 'building', progress: Math.min(1, this.done / this.total) }
      : { status: 'ready' }
    this.local.setState(state)
    this.emitState()
  }

  private emitState(): void {
    const s = this.state()
    for (const cb of [...this.stateListeners]) cb(s)
  }
}
