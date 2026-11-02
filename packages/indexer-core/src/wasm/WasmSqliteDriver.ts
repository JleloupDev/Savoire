// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Pilote SQL sur SQLite WebAssembly (@sqlite.org/sqlite-wasm, equipe SQLite,
// FTS5 compris). Pour le navigateur : il tourne DANS un Worker (voir
// worker.ts), seul endroit ou la persistance OPFS est possible. Marche aussi
// dans Node, en memoire (tests).
//
// L'API objet de SQLite WebAssembly est synchrone : le pilote l'enveloppe
// dans l'interface asynchrone du noyau. Cache d'instructions preparees comme
// le pilote node:sqlite.
import type { Database, PreparedStatement, SqlValue as WasmValue } from '@sqlite.org/sqlite-wasm'
import type { SqlDriver, SqlRow, SqlStatement, SqlValue } from '../driver'

export interface WasmSqliteOptions {
  /** Instructions preparees gardees en cache (defaut 500). */
  statementCache?: number
  /**
   * Journal : 'truncate' (defaut, sur et sans recreer de fichier), 'memory'
   * (base en memoire). Le VFS opfs-sahpool ne connait pas le WAL.
   */
  journal?: 'truncate' | 'memory'
}

function value(v: WasmValue): SqlValue {
  if (typeof v === 'bigint') return Number(v)
  if (v instanceof Int8Array || v instanceof ArrayBuffer) return new Uint8Array(v instanceof ArrayBuffer ? v : v.buffer)
  return v as SqlValue
}

export class WasmSqliteDriver implements SqlDriver {
  private readonly cache = new Map<string, PreparedStatement>()
  private readonly cacheSize: number

  constructor(private readonly db: Database, options: WasmSqliteOptions = {}) {
    this.cacheSize = options.statementCache ?? 500
    db.exec(`PRAGMA journal_mode = ${options.journal === 'memory' ? 'MEMORY' : 'TRUNCATE'}`)
    db.exec('PRAGMA synchronous = NORMAL')
    db.exec('PRAGMA temp_store = MEMORY')
  }

  private statement(text: string): { st: PreparedStatement; cached: boolean } {
    const hit = this.cache.get(text)
    if (hit) {
      // Le plus recent a la fin : le plus ancien part en premier.
      this.cache.delete(text)
      this.cache.set(text, hit)
      return { st: hit, cached: true }
    }
    const st = this.db.prepare(text)
    if (/^\s*(CREATE|DROP|ALTER)\b/i.test(text)) return { st, cached: false }
    this.cache.set(text, st)
    if (this.cache.size > this.cacheSize) {
      const oldest = this.cache.keys().next().value as string
      this.cache.get(oldest)?.finalize()
      this.cache.delete(oldest)
    }
    return { st, cached: true }
  }

  /** Execute une instruction ; `read` recoit chaque ligne. */
  private run(text: string, params: readonly SqlValue[] | undefined, read?: (names: string[], row: WasmValue[]) => void): void {
    const { st, cached } = this.statement(text)
    try {
      if (params?.length) st.bind(params as WasmValue[])
      let names: string[] | undefined
      while (st.step()) {
        if (!read) continue
        names ??= st.getColumnNames()
        read(names, st.get([]))
      }
    } finally {
      if (cached) st.resetNoThrow(true)
      else st.finalize()
    }
  }

  async exec(text: string): Promise<void> {
    this.db.exec(text)
  }

  async all<T extends object = SqlRow>(text: string, params: readonly SqlValue[] = []): Promise<T[]> {
    const out: SqlRow[] = []
    this.run(text, params, (names, row) => {
      const o: SqlRow = {}
      for (let i = 0; i < names.length; i++) o[names[i]!] = value(row[i]!)
      out.push(o)
    })
    return out as T[]
  }

  async batch(statements: readonly SqlStatement[]): Promise<void> {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      for (const s of statements) this.run(s.sql, s.params)
      this.db.exec('COMMIT')
    } catch (err) {
      this.db.exec('ROLLBACK')
      throw err
    }
  }

  async close(): Promise<void> {
    for (const st of this.cache.values()) st.finalize()
    this.cache.clear()
    this.db.close()
  }
}
