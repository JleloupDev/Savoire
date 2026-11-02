// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Ouvre une base SQLite WebAssembly, un fichier par vault.
//
// Persistance : le VFS `opfs-sahpool` (Origin Private File System, poignees
// d'acces synchrones), le plus rapide, sans en-tetes COOP/COEP ; Worker
// seulement. Il est installe une fois par Worker. Repli en memoire (l'etat le
// dit) quand il est indisponible :
//  - navigation privee, navigateur ancien, Node ;
//  - un autre onglet de la meme origine tient deja le pool (une seule
//    instance a la fois) : `preserveOnInitFailure` evite alors d'effacer
//    ses fichiers.
import sqlite3InitModule from '@sqlite.org/sqlite-wasm'
import type { SAHPoolUtil, Sqlite3Static } from '@sqlite.org/sqlite-wasm'
import { WasmSqliteDriver } from './WasmSqliteDriver'

/** Nom du VFS et dossier OPFS des index de Savoire. */
export const POOL_NAME = 'savoire-index'
export const POOL_DIRECTORY = '.savoire-index'

let sqlite: Promise<Sqlite3Static> | null = null
let pool: Promise<SAHPoolUtil | Error> | null = null

/** Le module SQLite (charge une fois). */
export function loadSqlite(): Promise<Sqlite3Static> {
  sqlite ??= sqlite3InitModule()
  return sqlite
}

function sahPool(sqlite3: Sqlite3Static): Promise<SAHPoolUtil | Error> {
  pool ??= (typeof sqlite3.installOpfsSAHPoolVfs === 'function'
    ? sqlite3.installOpfsSAHPoolVfs({ name: POOL_NAME, directory: POOL_DIRECTORY, preserveOnInitFailure: true })
    : Promise.reject(new Error('VFS opfs-sahpool absent')))
    .catch((err: unknown) => err instanceof Error ? err : new Error(String(err)))
  return pool
}

/** Nom du fichier d'un index dans le pool (chemin absolu, caracteres surs). */
export function indexFileName(name: string): string {
  return `/${name.replace(/[^A-Za-z0-9._-]/g, '_')}.sqlite`
}

export interface WasmOpenResult {
  driver: WasmSqliteDriver
  persistence: 'opfs' | 'memory'
  /** Pourquoi la base est en memoire alors que l'OPFS etait demande. */
  note?: string
}

export async function openWasmDatabase(name: string, persistence: 'opfs' | 'memory'): Promise<WasmOpenResult> {
  const sqlite3 = await loadSqlite()
  let note: string | undefined
  if (persistence === 'opfs') {
    const p = await sahPool(sqlite3)
    if (p instanceof Error) {
      note = `OPFS indisponible : ${p.message}`
    } else {
      try {
        // Deux places par base (fichier et journal), plus une de marge.
        await p.reserveMinimumCapacity(Number(p.getFileCount()) + 3)
        return { driver: new WasmSqliteDriver(new p.OpfsSAHPoolDb(indexFileName(name))), persistence: 'opfs' }
      } catch (err) {
        note = `OPFS illisible : ${err instanceof Error ? err.message : String(err)}`
      }
    }
  }
  return {
    driver: new WasmSqliteDriver(new sqlite3.oo1.DB(':memory:', 'c'), { journal: 'memory' }),
    persistence: 'memory',
    ...(note ? { note } : {}),
  }
}

/** Efface l'index d'un vault du pool OPFS (fichier illisible : il sera refait). */
export async function removeWasmDatabase(name: string): Promise<boolean> {
  const p = await sahPool(await loadSqlite())
  return p instanceof Error ? false : p.unlink(indexFileName(name))
}
