// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Pilote SQL du bureau : SQLite natif cote Rust (rusqlite, FTS5 compris),
// appele par les commandes Tauri de apps/desktop/src-tauri/src/index_db.rs.
// La base est `<vault>/.savoire/index.sqlite` (WAL) ; Rust n'accepte qu'une
// racine de vault ouverte par la personne.
//
// Le pont (invoke) est injecte : ce paquet ne depend pas de Tauri, et les
// tests passent par un autre transport vers le meme code Rust.
//
// Valeurs en JSON : un BLOB passe en hexadecimal, `{ "$hex": "..." }`.
import type { SqlDriver, SqlRow, SqlStatement, SqlValue } from '../driver'

/** Appel d'une commande Tauri (invoke de @tauri-apps/api/core). */
export type TauriInvoke = <T>(cmd: string, args: Record<string, unknown>) => Promise<T>

type WireValue = string | number | null | { $hex: string }

interface WireRows {
  columns: string[]
  rows: WireValue[][]
}

function toWire(v: SqlValue): WireValue {
  if (v instanceof Uint8Array) {
    let hex = ''
    for (const b of v) hex += b.toString(16).padStart(2, '0')
    return { $hex: hex }
  }
  return v
}

function fromWire(v: WireValue): SqlValue {
  if (v !== null && typeof v === 'object') {
    const out = new Uint8Array(v.$hex.length / 2)
    for (let i = 0; i < out.length; i++) out[i] = parseInt(v.$hex.slice(i * 2, i * 2 + 2), 16)
    return out
  }
  return v
}

export class TauriSqlDriver implements SqlDriver {
  constructor(
    private readonly invoke: TauriInvoke,
    /** Racine du vault : chemin absolu canonique, comme pour les commandes de fichiers. */
    readonly root: string,
  ) {}

  exec(sql: string): Promise<void> {
    return this.invoke('index_exec', { root: this.root, sql })
  }

  async all<T extends object = SqlRow>(sql: string, params: readonly SqlValue[] = []): Promise<T[]> {
    const r = await this.invoke<WireRows>('index_all', { root: this.root, sql, params: params.map(toWire) })
    return r.rows.map(row => {
      const o: SqlRow = {}
      for (let i = 0; i < r.columns.length; i++) o[r.columns[i]!] = fromWire(row[i] ?? null)
      return o as T
    })
  }

  batch(statements: readonly SqlStatement[]): Promise<void> {
    return this.invoke('index_batch', {
      root: this.root,
      statements: statements.map(s => ({ sql: s.sql, params: (s.params ?? []).map(toWire) })),
    })
  }

  close(): Promise<void> {
    return this.invoke('index_close', { root: this.root })
  }
}
