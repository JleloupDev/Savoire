// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Table de l'hote d'un index local (bureau, navigateur) : pour chaque note
// indexee, la signature de sa source (fichier : taille et date ; metadonnees
// partagees : empreinte). Au redemarrage, l'hote ne relit que ce qui a
// change : l'index n'est pas reconstruit.
//
// Ce n'est pas une table du noyau : elle part avec les autres quand le noyau
// change de version (VaultIndex.open vide toute la base), et l'hote la vide
// quand l'index est a reconstruire (version d'un pouvoir changee).
import type { SqlDriver, SqlStatement } from '../driver'
import { sql } from '../driver'

export const SOURCES_TABLE = 'host_sources'

/** Instructions par transaction. */
const CHUNK = 500

export class SourceTable {
  constructor(private readonly driver: SqlDriver) {}

  /** Cree la table ; `clear` : la vide (index a reconstruire). */
  async init(clear: boolean): Promise<void> {
    const stmts: SqlStatement[] = [
      sql(`CREATE TABLE IF NOT EXISTS ${SOURCES_TABLE} (id TEXT PRIMARY KEY, sig TEXT NOT NULL) WITHOUT ROWID`),
    ]
    if (clear) stmts.push(sql(`DELETE FROM ${SOURCES_TABLE}`))
    await this.driver.batch(stmts)
  }

  async all(): Promise<Map<string, string>> {
    const rows = await this.driver.all<{ id: string; sig: string }>(`SELECT id, sig FROM ${SOURCES_TABLE}`)
    return new Map(rows.map(r => [r.id, r.sig]))
  }

  async set(entries: Record<string, string>): Promise<void> {
    const list = Object.entries(entries)
    for (let i = 0; i < list.length; i += CHUNK) {
      await this.driver.batch(list.slice(i, i + CHUNK).map(([id, sig]) =>
        sql(`INSERT INTO ${SOURCES_TABLE} (id, sig) VALUES (?, ?) ON CONFLICT (id) DO UPDATE SET sig = excluded.sig`, id, sig)))
    }
  }

  async remove(ids: readonly string[]): Promise<void> {
    for (let i = 0; i < ids.length; i += CHUNK) {
      await this.driver.batch([
        sql(`DELETE FROM ${SOURCES_TABLE} WHERE id IN (SELECT value FROM json_each(?))`, JSON.stringify(ids.slice(i, i + CHUNK))),
      ])
    }
  }
}
