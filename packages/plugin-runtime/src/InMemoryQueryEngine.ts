// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Realisation de reference de IQueryEngine, en memoire. Elle sert :
//  - aux tests des plugins (comme InMemorySharedTree) ;
//  - de REFERENCE de comportement : les moteurs SQLite (pair indexeur,
//    bureau, navigateur) passent la meme suite de contrat.
// Adaptee a quelques milliers de notes ; au-dela, un moteur SQLite.
// Voir ADR-027.
import {
  QUERY_DEFAULT_LIMIT, QUERY_MAX_LIMIT,
} from '@savoire/plugin-api'
import type {
  IQueryEngine, IndexState, PropertyValue, Query, QueryErrorInfo, QueryField,
  QueryFilter, QueryGroup, QueryResult, QueryRow,
} from '@savoire/plugin-api'

/** Une note (ou une ligne legere de base) telle que l'index la voit. */
export interface IndexedDoc {
  id: string
  /** Chemin de la note ; vide pour une ligne legere. */
  path: string
  title: string
  /** Ligne legere : id du document de sa base. Absent pour une note. */
  base?: string
  /** Proprietes du frontmatter, deja typees. */
  props: Record<string, PropertyValue>
  /** Texte brut, pour le plein texte. */
  text?: string
  created?: string
  modified?: string
}

const MAX_FILTER_NODES = 64

export class QueryError extends Error implements QueryErrorInfo {
  constructor(readonly code: QueryErrorInfo['code'], message: string) {
    super(message)
  }
}

/** Minuscules, sans accents : les comparaisons de texte n'en tiennent pas compte. */
export function foldText(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
}

// Les memes valeurs reviennent sans cesse (statuts, choix) : on garde leur
// forme repliee. Borne pour ne pas grossir sans fin.
const foldCache = new Map<string, string>()
function fold(s: string): string {
  let f = foldCache.get(s)
  if (f === undefined) {
    if (foldCache.size > 200_000) foldCache.clear()
    f = foldText(s)
    foldCache.set(s, f)
  }
  return f
}

function isEmpty(v: PropertyValue | undefined): boolean {
  return v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0)
}

function folderOf(path: string): string {
  const i = path.lastIndexOf('/')
  return i < 0 ? '' : path.slice(0, i)
}

function extOf(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1)
  const i = name.lastIndexOf('.')
  return i <= 0 ? '' : name.slice(i + 1).toLowerCase()
}

function fieldValue(doc: IndexedDoc, field: QueryField): PropertyValue | undefined {
  if ('prop' in field) return doc.props[field.prop]
  switch (field.doc) {
    case 'path': return doc.path
    case 'title': return doc.title
    case 'folder': return folderOf(doc.path)
    case 'ext': return extOf(doc.path)
    case 'created': return doc.created
    case 'modified': return doc.modified
  }
}

/** Comparaison de deux valeurs non vides du meme genre ; texte replie. */
function compareScalar(a: PropertyValue, b: PropertyValue): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b
  if (typeof a === 'boolean' && typeof b === 'boolean') return Number(a) - Number(b)
  const fa = fold(String(a))
  const fb = fold(String(b))
  return fa < fb ? -1 : fa > fb ? 1 : 0
}

function scalarEquals(a: PropertyValue, b: PropertyValue): boolean {
  return compareScalar(a, b) === 0
}

function matches(doc: IndexedDoc, filter: QueryFilter): boolean {
  if ('and' in filter) return filter.and.every(f => matches(doc, f))
  if ('or' in filter) return filter.or.some(f => matches(doc, f))
  if ('not' in filter) return !matches(doc, filter.not)
  const v = fieldValue(doc, filter.field)
  const want = filter.value
  switch (filter.op) {
    case 'empty': return isEmpty(v)
    case 'notEmpty': return !isEmpty(v)
  }
  if (isEmpty(v) || want === undefined || want === null) return false
  const actual = v as PropertyValue
  if (Array.isArray(actual)) {
    // Liste : eq / contains = contient la valeur ; in = intersection.
    switch (filter.op) {
      case 'eq':
      case 'contains': return actual.some(x => scalarEquals(x, want as PropertyValue))
      case 'neq': return !actual.some(x => scalarEquals(x, want as PropertyValue))
      case 'in': return Array.isArray(want) && actual.some(x => want.some(w => scalarEquals(x, w)))
      default: return false
    }
  }
  switch (filter.op) {
    case 'eq': return scalarEquals(actual, want)
    case 'neq': return !scalarEquals(actual, want)
    case 'lt': return compareScalar(actual, want) < 0
    case 'lte': return compareScalar(actual, want) <= 0
    case 'gt': return compareScalar(actual, want) > 0
    case 'gte': return compareScalar(actual, want) >= 0
    case 'contains': return fold(String(actual)).includes(fold(String(want)))
    case 'startsWith': return fold(String(actual)).startsWith(fold(String(want)))
    case 'in': return Array.isArray(want) && want.some(w => scalarEquals(actual, w))
  }
  return false
}

function countNodes(filter: QueryFilter): number {
  if ('and' in filter) return 1 + filter.and.reduce((n, f) => n + countNodes(f), 0)
  if ('or' in filter) return 1 + filter.or.reduce((n, f) => n + countNodes(f), 0)
  if ('not' in filter) return 1 + countNodes(filter.not)
  return 1
}

function words(s: string): string[] {
  return foldText(s).split(/[^\p{L}\p{N}]+/u).filter(Boolean)
}

/** Cle de tri precalculee d'une valeur : evite de replier le texte a chaque comparaison. */
interface SortKey {
  empty: boolean
  raw: PropertyValue
  folded: string
}

function sortKey(v: PropertyValue | undefined): SortKey {
  if (isEmpty(v)) return { empty: true, raw: null, folded: '' }
  const raw = Array.isArray(v) ? v[0] : v as PropertyValue
  return { empty: false, raw, folded: typeof raw === 'number' || typeof raw === 'boolean' ? '' : fold(String(raw)) }
}

function compareKeys(a: SortKey, b: SortKey): number {
  if (typeof a.raw === 'number' && typeof b.raw === 'number') return a.raw - b.raw
  if (typeof a.raw === 'boolean' && typeof b.raw === 'boolean') return Number(a.raw) - Number(b.raw)
  const fa = a.folded || fold(String(a.raw))
  const fb = b.folded || fold(String(b.raw))
  return fa < fb ? -1 : fa > fb ? 1 : 0
}

/** Une note du dossier et des extensions demandes (corbeille et lignes legeres exclues). */
function isNoteOf(doc: IndexedDoc, prefix: string, exts: string[] | undefined): boolean {
  if (doc.base !== undefined) return false
  if (doc.path.startsWith('.trash/')) return false
  if (prefix && !doc.path.startsWith(prefix)) return false
  if (exts && !exts.includes(extOf(doc.path))) return false
  return true
}

function folderPrefix(folder: string | undefined): string {
  return folder ? folder.replace(/\/+$/, '') + '/' : ''
}

function normExts(ext: string[] | undefined): string[] | undefined {
  return ext?.map(e => e.toLowerCase().replace(/^\./, ''))
}

/** Empreinte de la requete sans son curseur : un curseur ne vaut que pour SA requete. */
function queryKey(q: Query): string {
  const { cursor: _cursor, limit: _limit, ...rest } = q
  return JSON.stringify(rest)
}

function encodeCursor(key: string, offset: number): string {
  return btoa(unescape(encodeURIComponent(JSON.stringify({ k: key, o: offset }))))
}

function decodeCursor(cursor: string, key: string): number {
  try {
    const { k, o } = JSON.parse(decodeURIComponent(escape(atob(cursor)))) as { k: string; o: number }
    if (k === key && Number.isInteger(o) && o >= 0) return o
  } catch { /* plus bas */ }
  throw new QueryError('invalid_cursor', 'Ce curseur ne correspond pas a cette requete.')
}

export class InMemoryQueryEngine implements IQueryEngine {
  private readonly docs = new Map<string, IndexedDoc>()
  private readonly words = new Map<string, Set<string>>()
  private current: IndexState = { status: 'ready' }
  private readonly stateListeners = new Set<(s: IndexState) => void>()
  private readonly watchers = new Set<() => void>()
  private batching = 0
  private dirty = false

  // ── Alimentation (par l'indexeur) ─────────────────────────────────────────

  upsert(doc: IndexedDoc): void {
    this.docs.set(doc.id, doc)
    this.words.set(doc.id, new Set([...words(doc.title), ...words(doc.text ?? '')]))
    this.changed()
  }

  remove(id: string): void {
    if (!this.docs.has(id)) return
    this.docs.delete(id)
    this.words.delete(id)
    this.changed()
  }

  /**
   * Groupe des modifications : les abonnes (watch) ne sont prevenus qu'une
   * fois, a la fin. Pour charger des milliers de lignes d'un coup.
   */
  batch(fn: () => void): void {
    this.batching++
    try { fn() } finally {
      this.batching--
      if (this.batching === 0 && this.dirty) {
        this.dirty = false
        this.changed()
      }
    }
  }

  upsertMany(docs: Iterable<IndexedDoc>): void {
    this.batch(() => { for (const d of docs) this.upsert(d) })
  }

  /** Les ids connus (notes et lignes legeres). */
  ids(): string[] {
    return [...this.docs.keys()]
  }

  get(id: string): IndexedDoc | undefined {
    return this.docs.get(id)
  }

  setState(state: IndexState): void {
    this.current = state
    for (const cb of [...this.stateListeners]) cb(state)
    this.changed()
  }

  // ── IQueryEngine ─────────────────────────────────────────────────────────

  async query(query: Query, options?: { signal?: AbortSignal }): Promise<QueryResult> {
    if (options?.signal?.aborted) throw new QueryError('unavailable', 'Requete annulee.')
    return this.run(query)
  }

  watch(query: Query, cb: (result: QueryResult) => void): () => void {
    const emit = () => { try { cb(this.run(query)) } catch { /* requete invalide : rien */ } }
    this.watchers.add(emit)
    emit()
    return () => { this.watchers.delete(emit) }
  }

  state(): IndexState {
    return this.current
  }

  onStateChange(cb: (state: IndexState) => void): () => void {
    this.stateListeners.add(cb)
    return () => { this.stateListeners.delete(cb) }
  }

  // ── Execution ────────────────────────────────────────────────────────────

  private changed(): void {
    if (this.batching > 0) { this.dirty = true; return }
    for (const w of [...this.watchers]) w()
  }

  private run(query: Query): QueryResult {
    const limit = query.limit ?? QUERY_DEFAULT_LIMIT
    if (!Number.isInteger(limit) || limit < 1 || limit > QUERY_MAX_LIMIT) {
      throw new QueryError('invalid_query', `limit doit etre entre 1 et ${QUERY_MAX_LIMIT}.`)
    }
    const from = query.from
    const pagesWhere = from && 'base' in from ? from.pages?.where : undefined
    const nodes = (query.where ? countNodes(query.where) : 0) + (pagesWhere ? countNodes(pagesWhere) : 0)
    if (nodes > MAX_FILTER_NODES) {
      throw new QueryError('too_complex', `Filtre trop complexe (plus de ${MAX_FILTER_NODES} conditions).`)
    }

    let inSource: (doc: IndexedDoc) => boolean
    if (from && 'notes' in from && from.notes) {
      const prefix = folderPrefix(from.folder)
      const exts = normExts(from.ext)
      inSource = doc => isNoteOf(doc, prefix, exts)
    } else if (from && 'base' in from && typeof from.base === 'string' && from.base) {
      const base = from.base
      const pages = from.pages
      const prefix = folderPrefix(pages?.folder)
      const exts = normExts(pages?.ext)
      inSource = doc => doc.base === base
        || (!!pages && isNoteOf(doc, prefix, exts) && (!pages.where || matches(doc, pages.where)))
    } else {
      throw new QueryError('invalid_query', 'Source inconnue.')
    }
    const terms = query.text ? words(query.text) : []

    const hits = [...this.docs.values()].filter(doc => {
      if (!inSource(doc)) return false
      if (terms.length) {
        const own = this.words.get(doc.id)!
        if (!terms.every(t => [...own].some(w => w.startsWith(t)))) return false
      }
      return !query.where || matches(doc, query.where)
    })

    const sort = query.sort ?? []
    if (sort.length > 0) {
      // Cles calculees une fois par document, pas a chaque comparaison.
      const keyed = hits.map(doc => ({ doc, keys: sort.map(s => sortKey(fieldValue(doc, s.field))) }))
      keyed.sort((a, b) => {
        for (let i = 0; i < sort.length; i++) {
          const ka = a.keys[i], kb = b.keys[i]
          // Vide en dernier, quel que soit le sens.
          if (ka.empty !== kb.empty) return ka.empty ? 1 : -1
          if (ka.empty) continue
          const c = compareKeys(ka, kb)
          if (c !== 0) return sort[i].dir === 'desc' ? -c : c
        }
        return a.doc.id < b.doc.id ? -1 : a.doc.id > b.doc.id ? 1 : 0
      })
      for (let i = 0; i < keyed.length; i++) hits[i] = keyed[i].doc
    } else {
      hits.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
    }

    let groups: QueryGroup[] | undefined
    if (query.groupBy) {
      const counts = new Map<string, QueryGroup>()
      for (const doc of hits) {
        const v = fieldValue(doc, query.groupBy)
        const keys: PropertyValue[] = isEmpty(v) ? [null] : Array.isArray(v) ? v : [v as PropertyValue]
        for (const key of keys) {
          const id = JSON.stringify(key)
          const g = counts.get(id) ?? { key, count: 0 }
          g.count++
          counts.set(id, g)
        }
      }
      // Les plus nombreux d'abord, puis par valeur (vide en dernier).
      groups = [...counts.values()].sort((a, b) =>
        b.count - a.count
        || Number(a.key === null) - Number(b.key === null)
        || (a.key === null || b.key === null ? 0 : compareScalar(a.key as PropertyValue, b.key as PropertyValue)))
    }

    const key = queryKey(query)
    const start = query.cursor ? decodeCursor(query.cursor, key) : 0
    const page = hits.slice(start, start + limit)
    const end = start + page.length

    const rows: QueryRow[] = page.map(doc => ({
      id: doc.id,
      path: doc.path,
      title: doc.title,
      values: query.select
        ? Object.fromEntries(query.select.filter(k => k in doc.props).map(k => [k, doc.props[k]]))
        : { ...doc.props },
    }))

    return {
      rows,
      next: end < hits.length ? encodeCursor(key, end) : undefined,
      total: hits.length,
      groups,
      index: this.current,
    }
  }
}
