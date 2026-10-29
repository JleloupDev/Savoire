// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Pilote SQL sur node:sqlite (integre a Node 22.5+, SQLite 3.51 avec FTS5
// dans Node 24) : aucune dependance npm. Pour le pair indexeur et les tests.
//
// Entree separee (@savoire/indexer-core/node) : les paquets web ne
// l'importent jamais. Le module est charge par process.getBuiltinModule :
// pas d'import statique que ferait suivre un bundler, pas de types Node
// necessaires au reste du paquet (on decrit ici le peu qu'on utilise).
//
// Reglages : WAL (lecteurs et ecrivain en parallele, entre processus),
// synchronous NORMAL (sur en WAL), busy_timeout, cache d'instructions
// preparees.
import type { SqlDriver, SqlRow, SqlStatement, SqlValue } from '../driver'

interface StatementLike {
  all(...params: SqlValue[]): unknown[]
  run(...params: SqlValue[]): unknown
}

/** Ce que l'on utilise de DatabaseSync (node:sqlite). */
export interface DatabaseLike {
  exec(sql: string): void
  prepare(sql: string): StatementLike
  close(): void
}

type DatabaseSyncCtor = new (path: string, options?: { timeout?: number; readOnly?: boolean }) => DatabaseLike

export interface NodeSqliteOptions {
  /** Attente maximale d'un verrou, en ms (defaut 5 000). */
  busyTimeoutMs?: number
  readOnly?: boolean
  /** Instructions preparees gardees en cache (defaut 500). */
  statementCache?: number
}

function loadSqlite(): DatabaseSyncCtor {
  const proc = (globalThis as { process?: { getBuiltinModule?: (id: string) => unknown } }).process
  const mod = proc?.getBuiltinModule?.('node:sqlite') as { DatabaseSync?: DatabaseSyncCtor } | undefined
  if (!mod?.DatabaseSync) throw new Error('node:sqlite indisponible : Node 22.5 ou plus requis.')
  return mod.DatabaseSync
}

export class NodeSqliteDriver implements SqlDriver {
  private readonly cache = new Map<string, StatementLike>()
  private readonly cacheSize: number

  /** Ouvre (ou cree) une base : un chemin de fichier, ou ':memory:'. */
  static open(path: string, options: NodeSqliteOptions = {}): NodeSqliteDriver {
    const DatabaseSync = loadSqlite()
    const db = new DatabaseSync(path, { timeout: options.busyTimeoutMs ?? 5000, readOnly: options.readOnly ?? false })
    return new NodeSqliteDriver(db, { ...options, wal: path !== ':memory:' && path !== '' && !options.readOnly })
  }

  constructor(private readonly db: DatabaseLike, options: NodeSqliteOptions & { wal?: boolean } = {}) {
    this.cacheSize = options.statementCache ?? 500
    db.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.floor(options.busyTimeoutMs ?? 5000))}`)
    if (options.wal) db.exec('PRAGMA journal_mode = WAL')
    db.exec('PRAGMA synchronous = NORMAL')
    db.exec('PRAGMA temp_store = MEMORY')
  }

  private statement(text: string): StatementLike {
    let s = this.cache.get(text)
    if (s) {
      // Le plus recent a la fin : le plus ancien part en premier.
      this.cache.delete(text)
      this.cache.set(text, s)
      return s
    }
    s = this.db.prepare(text)
    if (!/^\s*(CREATE|DROP|ALTER)\b/i.test(text)) {
      this.cache.set(text, s)
      if (this.cache.size > this.cacheSize) this.cache.delete(this.cache.keys().next().value as string)
    }
    return s
  }

  async exec(text: string): Promise<void> {
    this.db.exec(text)
  }

  async all<T extends object = SqlRow>(text: string, params: readonly SqlValue[] = []): Promise<T[]> {
    return this.statement(text).all(...params) as T[]
  }

  async batch(statements: readonly SqlStatement[]): Promise<void> {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      for (const s of statements) this.statement(s.sql).run(...(s.params ?? []))
      this.db.exec('COMMIT')
    } catch (err) {
      this.db.exec('ROLLBACK')
      throw err
    }
  }

  async close(): Promise<void> {
    this.cache.clear()
    this.db.close()
  }
}
