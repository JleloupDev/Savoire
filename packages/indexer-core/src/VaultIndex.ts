// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// L'index SQLite d'UN vault : derive des documents, jamais synchronise,
// toujours reconstructible. Le meme code sert le pair indexeur (Node), le
// navigateur (Worker) et le bureau (Tauri) : seul le pilote change.
//
//  - open() cree ou met a niveau le schema. L'index etant derive, il n'y a
//    pas de migration en place : une version differente (noyau ou pouvoir)
//    vide les tables concernees et demande une reconstruction
//    (rebuildRequired, sequence remise a 0) ;
//  - applyDoc / applyDocs / removeDoc / moveDoc : une note = ses
//    instructions, calculees par chaque pouvoir, puis UN batch (transaction).
//    La sequence du flux de changements peut etre ecrite dans le meme batch ;
//  - call(capacite, methode, params) : point d'entree du protocole ;
//  - queryEngine() / searchEngine() : les contrats de l'appli, dont watch se
//    relance apres chaque modification.
//
// Les operations sont executees une a une, dans l'ordre des appels : une
// lecture lancee avant une ecriture ne la voit pas, une lecture lancee apres
// la voit. Un seul ecrivain par vault, donc.
import type {
  IQueryEngine, ISearchEngine, IndexState, PropertySchema, Query, QueryResult, SearchQuery, SearchResult,
} from '@savoire/plugin-api'
import { CORE_SCHEMA, CORE_VERSION, META_SCHEMA, foldOrNull, pathColumns, setMeta, upsertDoc } from './core'
import type { SqlDriver, SqlStatement } from './driver'
import { sql } from './driver'
import { IndexError } from './errors'
import { extractNote } from './extract/note'
import type { NoteInput, NoteRecord } from './extract/note'
import { extOf, folderOf, isTrashPath, stemOf } from './paths'
import type { DocRef, IndexPower, MethodOptions, PowerContext } from './power'
import { defaultPowers } from './powers'

export interface VaultIndexOptions {
  /** Pouvoirs inscrits ; defaultPowers() si absent. */
  powers?: readonly IndexPower[]
  /** Types declares des proprietes du vault. */
  schema?: PropertySchema
}

export interface WriteOptions {
  /** Sequence du flux de changements, ecrite dans la meme transaction. */
  seq?: number
}

export type MoveResult = 'moved' | 'unchanged' | 'removed' | 'missing'

/** Ce que open() ferait d'une base existante, lu sans rien y ecrire (VaultIndex.inspect). */
export interface IndexInspection {
  /** La base a deja un schema (table meta). */
  exists: boolean
  /** open() viderait au moins une table : reconstruction a faire. */
  rebuildRequired: boolean
  /** Le noyau est d'une autre version : open() viderait tout. */
  coreChanged: boolean
  /** Index construit en entier (markBuilt) avec ce schema. */
  built: boolean
  /** Derniere sequence traitee. */
  seq: number
  /** Pouvoirs dont les tables resteraient intactes a l'ouverture (meme version). */
  intact: string[]
  /** Pouvoirs nouveaux ou d'une autre version : leurs tables seraient videes. */
  changed: string[]
  /** Valeurs de l'hote (setHostMeta). */
  host: Record<string, string>
}

const HOST_PREFIX = 'host:'

interface StoredPower { v: number; tables: string[] }

function unavailable(): IndexError {
  return new IndexError('unavailable', 'Requete annulee.')
}

export class VaultIndex {
  private tail: Promise<unknown> = Promise.resolve()
  private current: IndexState = { status: 'ready' }
  private readonly stateListeners = new Set<(s: IndexState) => void>()
  private readonly changeListeners = new Set<() => void>()
  private readonly byName = new Map<string, IndexPower>()
  private readonly ctx: PowerContext
  private query?: IQueryEngine
  private search?: ISearchEngine

  private constructor(
    private readonly driver: SqlDriver,
    private readonly powers: readonly IndexPower[],
    private schema: PropertySchema | undefined,
    private nextN: number,
    private rebuild: boolean,
  ) {
    for (const p of powers) this.byName.set(p.name, p)
    this.ctx = {
      driver,
      api: <T>(name: string) => this.byName.get(name)?.api as T | undefined,
      state: () => this.current,
    }
  }

  /** Ouvre l'index sur un pilote : cree le schema, ou le remet a niveau. */
  static async open(driver: SqlDriver, options: VaultIndexOptions = {}): Promise<VaultIndex> {
    const powers = options.powers ?? defaultPowers()
    const names = new Set<string>()
    for (const p of powers) {
      if (names.has(p.name)) throw new Error(`Pouvoir inscrit deux fois : ${p.name}`)
      names.add(p.name)
    }

    await driver.exec(META_SCHEMA)
    const meta = new Map((await driver.all<{ key: string; value: string }>('SELECT key, value FROM meta')).map(r => [r.key, r.value]))
    const stmts: SqlStatement[] = []
    // Tables videes (noyau ou pouvoir d'une autre version, pouvoir nouveau) :
    // l'index est a reconstruire, depuis la sequence 0.
    let emptied = false

    const reset = meta.get('core') !== String(CORE_VERSION)
    if (reset) {
      // Base neuve, ou noyau d'une autre version : on repart de zero.
      await dropAllTables(driver)
      stmts.push(sql('DELETE FROM meta'))
      emptied = true
    }
    for (const s of CORE_SCHEMA) stmts.push(sql(s))
    stmts.push(setMeta('core', CORE_VERSION))

    for (const p of powers) {
      const stored = reset ? undefined : parseStored(meta.get(`power:${p.name}`))
      if (!stored || stored.v !== p.version) {
        for (const t of new Set([...(stored?.tables ?? []), ...(p.tables ?? [])])) stmts.push(sql(`DROP TABLE IF EXISTS "${t.replace(/"/g, '')}"`))
        emptied = true
      }
      for (const s of p.schema ?? []) stmts.push(sql(s))
      stmts.push(setMeta(`power:${p.name}`, JSON.stringify({ v: p.version, tables: [...(p.tables ?? [])] } satisfies StoredPower)))
    }
    // Pouvoirs qui ne sont plus inscrits : leurs tables partent.
    if (!reset) {
      for (const [key, value] of meta) {
        if (!key.startsWith('power:') || names.has(key.slice(6))) continue
        for (const t of parseStored(value)?.tables ?? []) stmts.push(sql(`DROP TABLE IF EXISTS "${t.replace(/"/g, '')}"`))
        stmts.push(sql('DELETE FROM meta WHERE key = ?', key))
      }
    }
    if (emptied) {
      stmts.push(setMeta('built', 0))
      stmts.push(setMeta('seq', 0))
    }
    await driver.batch(stmts)
    const [max] = await driver.all<{ m: number }>('SELECT coalesce(max(n), 0) AS m FROM docs')
    const rebuild = emptied || meta.get('built') !== '1'
    return new VaultIndex(driver, powers, options.schema, Number(max?.m ?? 0) + 1, rebuild)
  }

  /**
   * Lit l'etat d'une base sans l'ouvrir ni rien y ecrire : l'hote decide
   * avant open() s'il reconstruit a cote (l'ancienne version repond pendant
   * ce temps avec ses pouvoirs intacts) ou en place.
   */
  static async inspect(driver: SqlDriver, options: Pick<VaultIndexOptions, 'powers'> = {}): Promise<IndexInspection> {
    const powers = options.powers ?? defaultPowers()
    const [hasMeta] = await driver.all<{ c: number }>("SELECT count(*) AS c FROM sqlite_master WHERE type = 'table' AND name = 'meta'")
    const meta = Number(hasMeta?.c ?? 0) > 0
      ? new Map((await driver.all<{ key: string; value: string }>('SELECT key, value FROM meta')).map(r => [r.key, r.value]))
      : new Map<string, string>()
    const exists = meta.size > 0
    const coreChanged = meta.get('core') !== String(CORE_VERSION)
    const intact: string[] = []
    const changed: string[] = []
    for (const p of powers) {
      const stored = coreChanged ? undefined : parseStored(meta.get(`power:${p.name}`))
      if (stored && stored.v === p.version) intact.push(p.name)
      else changed.push(p.name)
    }
    const host: Record<string, string> = {}
    for (const [k, v] of meta) if (k.startsWith(HOST_PREFIX)) host[k.slice(HOST_PREFIX.length)] = v
    return {
      exists,
      rebuildRequired: coreChanged || changed.length > 0 || meta.get('built') !== '1',
      coreChanged,
      built: meta.get('built') === '1',
      seq: Number(meta.get('seq') ?? 0),
      intact,
      changed,
      host,
    }
  }

  // ── Etat ─────────────────────────────────────────────────────────────────

  /** Vrai tant que l'index n'a pas ete construit en entier depuis sa creation ou sa remise a zero. */
  get rebuildRequired(): boolean {
    return this.rebuild
  }

  /** L'hote a (re)construit tout l'index : il est complet. Les statistiques du planificateur sont mises a jour. */
  markBuilt(): Promise<void> {
    return this.enqueue(async () => {
      await this.driver.batch([setMeta('built', 1)])
      await this.driver.exec('PRAGMA optimize')
      this.rebuild = false
    })
  }

  state(): IndexState {
    return this.current
  }

  /** Etat affiche (construction, retard...) : rendu avec chaque resultat. */
  setState(state: IndexState): void {
    this.current = state
    for (const cb of [...this.stateListeners]) cb(state)
    this.changed()
  }

  onStateChange(cb: (state: IndexState) => void): () => void {
    this.stateListeners.add(cb)
    return () => { this.stateListeners.delete(cb) }
  }

  /** Prevenu apres chaque modification de l'index. */
  onChange(cb: () => void): () => void {
    this.changeListeners.add(cb)
    return () => { this.changeListeners.delete(cb) }
  }

  /** Types des proprietes : valent pour les notes ecrites ensuite (reconstruire pour le reste). */
  setSchema(schema: PropertySchema | undefined): void {
    this.schema = schema
  }

  /** Derniere sequence traitee du flux de changements. */
  seq(): Promise<number> {
    return this.enqueue(async () => {
      const [r] = await this.driver.all<{ v: string }>("SELECT value AS v FROM meta WHERE key = 'seq'")
      return Number(r?.v ?? 0)
    })
  }

  setSeq(seq: number): Promise<void> {
    return this.enqueue(() => this.driver.batch([setMeta('seq', seq)]))
  }

  /**
   * id -> chemin des notes indexees (pour comparer a l'arbre du vault :
   * diffTree). `ids` : seulement celles-ci (celles qui ne sont pas indexees
   * sont absentes du resultat).
   */
  paths(ids?: readonly string[]): Promise<Map<string, string>> {
    return this.enqueue(async () => {
      const rows = ids
        ? await this.driver.all<{ id: string; path: string }>(
          'SELECT id, path FROM docs WHERE base IS NULL AND id IN (SELECT value FROM json_each(?))', [JSON.stringify([...new Set(ids)])])
        : await this.driver.all<{ id: string; path: string }>('SELECT id, path FROM docs WHERE base IS NULL')
      return new Map(rows.map(r => [r.id, r.path]))
    })
  }

  /**
   * Valeurs propres a l'hote, rangees avec l'index (le pair y note l'epoque
   * du flux, par exemple). Effacees avec tout le reste quand le noyau change.
   */
  hostMeta(): Promise<Record<string, string>> {
    return this.enqueue(async () => {
      const rows = await this.driver.all<{ key: string; value: string }>(
        'SELECT key, value FROM meta WHERE substr(key, 1, ?) = ?', [HOST_PREFIX.length, HOST_PREFIX])
      return Object.fromEntries(rows.map(r => [r.key.slice(HOST_PREFIX.length), r.value]))
    })
  }

  setHostMeta(values: Record<string, string | number>): Promise<void> {
    const stmts = Object.entries(values).map(([k, v]) => setMeta(HOST_PREFIX + k, v))
    return stmts.length ? this.enqueue(() => this.driver.batch(stmts)) : Promise.resolve()
  }

  // ── Ecriture ─────────────────────────────────────────────────────────────

  /** Indexe une note (extraction comprise). Une note de la corbeille est retiree. */
  applyDoc(input: NoteInput, options?: WriteOptions): Promise<void> {
    return this.applyDocs([input], options)
  }

  /** Plusieurs notes en une transaction (construction par lots). */
  applyDocs(inputs: readonly NoteInput[], options?: WriteOptions): Promise<void> {
    const records: NoteRecord[] = []
    const removals: string[] = []
    for (const input of inputs) {
      if (isTrashPath(input.path)) removals.push(input.id)
      else records.push(extractNote(input, { schema: this.schema }))
    }
    return this.write(records, removals, options)
  }

  /** Notes deja lues (makeRecord, extractNote, lignes legeres de base). */
  applyRecords(records: readonly NoteRecord[], options?: WriteOptions): Promise<void> {
    return this.write(
      records.filter(r => r.base !== undefined || !isTrashPath(r.path)),
      records.filter(r => r.base === undefined && isTrashPath(r.path)).map(r => r.id),
      options)
  }

  removeDoc(id: string, options?: WriteOptions): Promise<void> {
    return this.write([], [id], options)
  }

  removeDocs(ids: readonly string[], options?: WriteOptions): Promise<void> {
    return this.write([], ids, options)
  }

  /**
   * Le document change de chemin, contenu inchange. 'missing' : le document
   * n'est pas (ou plus) indexe, l'hote doit le relire (sortie de corbeille,
   * changement d'extension). 'removed' : il est parti a la corbeille.
   */
  moveDoc(id: string, path: string, options?: WriteOptions): Promise<MoveResult> {
    return this.enqueue(async () => {
      const doc = (await this.lookup([id])).get(id)
      const stmts: SqlStatement[] = []
      let result: MoveResult
      if (!doc || doc.base) {
        result = isTrashPath(path) ? 'removed' : 'missing'
      } else if (isTrashPath(path) || extOf(path) !== extOf(doc.path)) {
        stmts.push(...await this.removal(doc))
        result = isTrashPath(path) ? 'removed' : 'missing'
      } else if (path === doc.path) {
        result = 'unchanged'
      } else {
        const [row] = await this.driver.all<{ title: string; src: string }>('SELECT title, title_src AS src FROM docs WHERE n = ?', [doc.n])
        const title = row?.src === 'name' ? stemOf(path) : row?.title ?? stemOf(path)
        const cols = { ...pathColumns(path, folderOf(path), extOf(path)), title, title_fold: foldOrNull(title) }
        stmts.push(sql(`UPDATE docs SET ${Object.keys(cols).map(k => `${k} = ?`).join(', ')} WHERE n = ?`, ...Object.values(cols), doc.n))
        const moved: DocRef = { ...doc, path }
        for (const p of this.powers) {
          if (p.move) stmts.push(...await p.move(this.ctx, moved, { path: doc.path, title: row?.title ?? '' }, { path, title }))
        }
        result = 'moved'
      }
      if (options?.seq !== undefined) stmts.push(setMeta('seq', options.seq))
      if (stmts.length) {
        await this.driver.batch(stmts)
        if (result !== 'unchanged') this.changed()
      }
      return result
    })
  }

  /** Donnees pour un pouvoir qui ne les tire pas des notes (voir IndexPower.ingest). */
  ingest(capability: string, input: unknown): Promise<void> {
    const p = this.byName.get(capability)
    if (!p?.ingest) return Promise.reject(new IndexError('unknown_capability', `Pouvoir sans entree de donnees : ${capability}`))
    return this.enqueue(async () => {
      const stmts = await p.ingest!(this.ctx, input)
      if (!stmts.length) return
      await this.driver.batch(stmts)
      this.changed()
    })
  }

  private write(records: readonly NoteRecord[], removals: readonly string[], options?: WriteOptions): Promise<void> {
    return this.enqueue(async () => {
      const existing = await this.lookup([...records.map(r => r.id), ...removals])
      const stmts: SqlStatement[] = []
      for (const id of removals) {
        const doc = existing.get(id)
        if (!doc) continue
        stmts.push(...await this.removal(doc))
        existing.delete(id)
      }
      for (const note of records) {
        const old = existing.get(note.id)
        if (old) for (const p of this.powers) if (p.remove) stmts.push(...await p.remove(this.ctx, old))
        const doc: DocRef = { n: old?.n ?? this.nextN++, id: note.id, path: note.path, base: note.base ?? null }
        stmts.push(upsertDoc(doc.n, note))
        for (const p of this.powers) if (p.write) stmts.push(...await p.write(this.ctx, doc, note))
        existing.set(note.id, doc)
      }
      if (options?.seq !== undefined) stmts.push(setMeta('seq', options.seq))
      if (!stmts.length) return
      await this.driver.batch(stmts)
      if (records.length || removals.length) this.changed()
    })
  }

  private async removal(doc: DocRef): Promise<SqlStatement[]> {
    const out: SqlStatement[] = []
    for (const p of this.powers) if (p.remove) out.push(...await p.remove(this.ctx, doc))
    out.push(sql('DELETE FROM docs WHERE n = ?', doc.n))
    for (const p of this.powers) if (p.afterRemove) out.push(...await p.afterRemove(this.ctx, doc))
    return out
  }

  private async lookup(ids: readonly string[]): Promise<Map<string, DocRef>> {
    const out = new Map<string, DocRef>()
    if (!ids.length) return out
    const rows = await this.driver.all<{ n: number; id: string; path: string; base: string | null }>(
      'SELECT n, id, path, base FROM docs WHERE id IN (SELECT value FROM json_each(?))', [JSON.stringify([...new Set(ids)])])
    for (const r of rows) out.set(r.id, { n: Number(r.n), id: r.id, path: r.path, base: r.base })
    return out
  }

  // ── Lecture ──────────────────────────────────────────────────────────────

  /** Les pouvoirs inscrits et leurs methodes. */
  capabilities(): { name: string; version: number; methods: string[] }[] {
    return this.powers.map(p => ({ name: p.name, version: p.version, methods: Object.keys(p.methods ?? {}) }))
  }

  /**
   * Appel `capacite.methode` du protocole. Les parametres sont verifies par
   * le pouvoir ; erreurs : IndexError (unknown_capability, unknown_method,
   * invalid_query, invalid_cursor, too_complex, unavailable).
   */
  async call(capability: string, methodName: string, params: unknown, options: MethodOptions = {}): Promise<unknown> {
    const p = this.byName.get(capability)
    if (!p) throw new IndexError('unknown_capability', `Pouvoir inconnu : ${capability}`)
    const m = p.methods && Object.prototype.hasOwnProperty.call(p.methods, methodName) ? p.methods[methodName] : undefined
    if (!m) throw new IndexError('unknown_method', `Methode inconnue : ${capability}.${methodName}`)
    if (options.signal?.aborted) throw unavailable()
    const parsed = m.parse(params)
    return this.enqueue(async () => {
      if (options.signal?.aborted) throw unavailable()
      return m.run(this.ctx, parsed, options)
    })
  }

  /** Le moteur de requetes de l'appli, sur cet index. */
  queryEngine(): IQueryEngine {
    this.query ??= {
      query: (q: Query, options?: { signal?: AbortSignal }) => this.call('query', 'run', q, options) as Promise<QueryResult>,
      watch: (q: Query, cb: (r: QueryResult) => void) => this.watch(q, cb),
      state: () => this.state(),
      onStateChange: cb => this.onStateChange(cb),
    }
    return this.query
  }

  /** La recherche plein texte de l'appli, sur cet index. */
  searchEngine(): ISearchEngine {
    this.search ??= {
      search: (q: SearchQuery, options?: { signal?: AbortSignal }) => this.call('search', 'run', q, options) as Promise<SearchResult>,
      state: () => this.state(),
      onStateChange: cb => this.onStateChange(cb),
    }
    return this.search
  }

  close(): Promise<void> {
    return this.enqueue(() => this.driver.close())
  }

  // ── Interne ──────────────────────────────────────────────────────────────

  private watch(query: Query, cb: (r: QueryResult) => void): () => void {
    let stopped = false
    let running = false
    let again = false
    const run = () => {
      if (stopped) return
      // Une requete en cours a pu lire l'index avant ce changement : on la
      // relancera a la fin (au plus une fois, quel que soit le nombre de
      // changements entre-temps).
      if (running) { again = true; return }
      running = true
      this.call('query', 'run', query)
        .then(r => { if (!stopped) cb(r as QueryResult) }, () => { /* requete invalide : rien */ })
        .finally(() => {
          running = false
          if (again) { again = false; run() }
        })
    }
    const off = this.onChange(run)
    run()
    return () => { stopped = true; off() }
  }

  private changed(): void {
    for (const cb of [...this.changeListeners]) cb()
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.tail.then(fn)
    this.tail = run.catch(() => undefined)
    return run
  }
}

function parseStored(value: string | undefined): StoredPower | undefined {
  if (!value) return undefined
  try {
    const v = JSON.parse(value) as StoredPower
    return typeof v?.v === 'number' && Array.isArray(v.tables) ? v : undefined
  } catch {
    return undefined
  }
}

/** Vide la base (sauf meta) : tables virtuelles d'abord, leurs tables annexes partent avec. */
async function dropAllTables(driver: SqlDriver): Promise<void> {
  const list = () => driver.all<{ name: string; sql: string | null }>(
    "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> 'meta'")
  const quote = (n: string) => `"${n.replace(/"/g, '""')}"`
  const virtual = (await list()).filter(t => /^\s*CREATE\s+VIRTUAL/i.test(t.sql ?? ''))
  for (const t of virtual) await driver.exec(`DROP TABLE IF EXISTS ${quote(t.name)}`)
  for (const t of await list()) await driver.exec(`DROP TABLE IF EXISTS ${quote(t.name)}`)
}
