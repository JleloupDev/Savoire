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
  FieldReader, QUERY_DEFAULT_LIMIT, QUERY_MAX_AGGREGATES, QUERY_MAX_LIMIT, QueryEvalError, aggregateDocs, checkAggregates,
  foldText, groupDocs, matchesDoc, sortDocs,
} from '@savoire/plugin-api'
import type {
  IQueryEngine, IndexState, PropertyValue, Query, QueryErrorInfo, QueryFilter, QueryGroup, QueryResult, QueryRow,
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

/** Minuscules, sans accents (voir queryEval.ts, la semantique commune). */
export { foldText }

function extOf(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1)
  const i = name.lastIndexOf('.')
  return i <= 0 ? '' : name.slice(i + 1).toLowerCase()
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

    // Formules (champs { formula }) et agregats verifies d'abord ; meme ordre de refus partout.
    let reader: FieldReader
    try {
      reader = new FieldReader(query)
      checkAggregates(query.aggregate, QUERY_MAX_AGGREGATES)
    } catch (err) {
      if (err instanceof QueryEvalError) throw new QueryError(err.code, err.message)
      throw err
    }
    const matches = (doc: IndexedDoc, f: QueryFilter) => matchesDoc(reader, doc, f)

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

    sortDocs(reader, hits, query.sort ?? [])
    const groups: QueryGroup[] | undefined = query.groupBy ? groupDocs(reader, hits, query.groupBy) : undefined
    const aggregates: PropertyValue[] | undefined = query.aggregate ? query.aggregate.map(a => aggregateDocs(reader, hits, a)) : undefined

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
      ...(aggregates ? { aggregates } : {}),
      index: this.current,
    }
  }
}
