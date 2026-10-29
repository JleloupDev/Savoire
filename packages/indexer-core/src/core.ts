// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Tables du noyau, communes a tous les pouvoirs :
//  - meta : version du schema, versions des pouvoirs, derniere sequence
//    traitee, index construit ou non ;
//  - docs : une ligne par note (ou ligne legere de base), cle interne `n`
//    a laquelle les tables des pouvoirs se rattachent. Colonnes brutes et
//    repliees (NULL si vides) des champs du document, cles des liens,
//    proprietes en JSON (valeurs rendues par les requetes).
import { sql } from './driver'
import type { SqlStatement } from './driver'
import type { NoteRecord } from './extract/note'
import { docKeys } from './paths'
import { foldText } from './text'

/** Version du schema du noyau : la changer fait reconstruire tout l'index. */
export const CORE_VERSION = 1

export const META_SCHEMA = 'CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)'

export const CORE_SCHEMA: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS docs (
    n INTEGER PRIMARY KEY,
    id TEXT NOT NULL UNIQUE,
    base TEXT,
    path TEXT NOT NULL,
    path_fold TEXT,
    title TEXT NOT NULL,
    title_fold TEXT,
    title_src TEXT NOT NULL,
    folder TEXT NOT NULL,
    folder_fold TEXT,
    ext TEXT NOT NULL,
    ext_fold TEXT,
    created TEXT,
    created_fold TEXT,
    modified TEXT,
    modified_fold TEXT,
    name_key TEXT NOT NULL,
    name_full_key TEXT NOT NULL,
    path_key TEXT NOT NULL,
    full_key TEXT NOT NULL,
    props TEXT NOT NULL
  )`,
  'CREATE INDEX IF NOT EXISTS docs_path ON docs (path)',
  'CREATE INDEX IF NOT EXISTS docs_base ON docs (base) WHERE base IS NOT NULL',
  'CREATE INDEX IF NOT EXISTS docs_name ON docs (name_key)',
  'CREATE INDEX IF NOT EXISTS docs_name_full ON docs (name_full_key)',
  'CREATE INDEX IF NOT EXISTS docs_title ON docs (title_fold)',
]

/** Repli d'un champ ; NULL quand il est vide (meme regle que le moteur de reference). */
export function foldOrNull(s: string | null | undefined): string | null {
  return s ? foldText(s) : null
}

/** Colonnes de chemin d'un document (deplacement compris). */
export function pathColumns(path: string, folder: string, ext: string): Record<string, string | null> {
  const k = path ? docKeys(path) : { nameKey: '', nameFullKey: '', pathKey: '', fullKey: '' }
  return {
    path,
    path_fold: foldOrNull(path),
    folder,
    folder_fold: foldOrNull(folder),
    ext,
    ext_fold: foldOrNull(ext),
    name_key: k.nameKey,
    name_full_key: k.nameFullKey,
    path_key: k.pathKey,
    full_key: k.fullKey,
  }
}

/** Ecrit (ou remplace) la ligne `docs` d'une note. */
export function upsertDoc(n: number, note: NoteRecord): SqlStatement {
  const cols: Record<string, string | number | null> = {
    n,
    id: note.id,
    base: note.base ?? null,
    ...pathColumns(note.path, note.folder, note.ext),
    title: note.title,
    title_fold: foldOrNull(note.title),
    title_src: note.titleSource,
    created: note.created ?? null,
    created_fold: foldOrNull(note.created),
    modified: note.modified ?? null,
    modified_fold: foldOrNull(note.modified),
    props: JSON.stringify(note.props),
  }
  const names = Object.keys(cols)
  return sql(
    `INSERT OR REPLACE INTO docs (${names.join(', ')}) VALUES (${names.map(() => '?').join(', ')})`,
    ...Object.values(cols))
}

export function setMeta(key: string, value: string | number): SqlStatement {
  return sql('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value', key, String(value))
}
