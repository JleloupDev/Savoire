// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Bases et lignes legeres, lues dans leurs Y.Doc (format : plugin-api,
// query.ts, « Lignes legeres d'une base » ; ecrit par plugin-base).
//
//  - le document de la base (.base) est un arbre partage : racine 'tree',
//    manifeste sous 'base' ; 'lotCount' et 'lots' (numero -> true) disent
//    quels lots existent ;
//  - chaque lot est un document ANNEXE, d'id `<id de la base>~lot-NNN`,
//    absent de l'arborescence du vault ; sa racine porte une carte par
//    ligne (`row:<id>`), propriete -> valeur, 'title' etant le nom.
//
// Les valeurs sont typees comme chez les clients (QueryEngineProvider) :
// type declare s'il y en a un, sinon devine sur la valeur.
import * as Y from 'yjs'
import {
  BASE_LOT_COUNT, BASE_ROW_PREFIX, BASE_ROW_TITLE, baseLotName, coercePropertyValue, guessPropertyType,
} from '@savoire/plugin-api'
import type { PropertySchema, PropertyValue } from '@savoire/plugin-api'
import { makeRecord } from '../extract/note'
import type { NoteRecord } from '../extract/note'
import { TREE_ROOT } from './content'
import { withDoc } from './yjs'
import type { YjsUpdate } from './yjs'

/** Cle du manifeste dans l'arbre du document de la base. */
export const BASE_KEY = 'base'
const ANNEX_SEP = '~'

export interface BaseManifest {
  lotCount: number
  /** Lots qui existent (numeros), dans l'ordre. */
  lots: number[]
}

export interface LightRow {
  id: string
  title: string
  /** Valeurs brutes (avant typage). */
  values: Record<string, PropertyValue>
}

/** Id du document d'un lot. */
export function lotDocId(baseId: string, lot: number): string {
  return `${baseId}${ANNEX_SEP}${baseLotName(lot)}`
}

/** `<base>~lot-NNN` -> { base, lot } ; null pour tout autre document. */
export function parseLotDocId(docId: string): { baseId: string; lot: number } | null {
  const m = /^(.+)~lot-(\d{3,})$/.exec(docId)
  if (!m) return null
  const lot = Number(m[2])
  return Number.isSafeInteger(lot) ? { baseId: m[1]!, lot } : null
}

/** Manifeste d'une base ; null si le document n'en porte pas (encore). */
export function readBaseManifest(doc: Y.Doc): BaseManifest | null {
  const base = doc.getMap<unknown>(TREE_ROOT).get(BASE_KEY)
  if (!(base instanceof Y.Map)) return null
  const count = base.get('lotCount')
  const lotCount = typeof count === 'number' && Number.isInteger(count) && count > 0 ? count : BASE_LOT_COUNT
  const lots: number[] = []
  const map = base.get('lots')
  if (map instanceof Y.Map) {
    for (const key of map.keys()) {
      const n = Number(key)
      if (Number.isInteger(n) && n >= 0) lots.push(n)
    }
  }
  lots.sort((a, b) => a - b)
  return { lotCount, lots }
}

export function baseManifestFromUpdates(updates: readonly YjsUpdate[]): BaseManifest | null {
  return withDoc(updates, readBaseManifest)
}

function plain(v: unknown): PropertyValue {
  if (v === null || v === undefined) return null
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v
  if (v instanceof Y.Array) return v.toArray().filter((x): x is string | number | boolean => x !== null && x !== undefined && typeof x !== 'object').map(String)
  if (v instanceof Y.Text) return v.toString()
  return null
}

/** Les lignes d'un lot. */
export function readLotRows(doc: Y.Doc): LightRow[] {
  const out: LightRow[] = []
  doc.getMap<unknown>(TREE_ROOT).forEach((row, key) => {
    if (!key.startsWith(BASE_ROW_PREFIX) || !(row instanceof Y.Map)) return
    const values: Record<string, PropertyValue> = {}
    let title = ''
    row.forEach((v, k) => {
      const p = plain(v)
      if (k === BASE_ROW_TITLE) title = p === null ? '' : String(p)
      else values[k] = p
    })
    out.push({ id: key.slice(BASE_ROW_PREFIX.length), title, values })
  })
  return out
}

export function lotRowsFromUpdates(updates: readonly YjsUpdate[]): LightRow[] {
  return withDoc(updates, readLotRows)
}

/** Valeur telle que l'ecrit un client : guillemets YAML retires, listes de textes. */
function normalize(v: PropertyValue): PropertyValue {
  if (typeof v === 'string') {
    const q = /^(["'])(.*)\1$/.exec(v)
    return q ? q[2]! : v
  }
  return v
}

/** Enregistrement d'index d'une ligne legere (VaultIndex.applyRecords). */
export function lightRowRecord(baseId: string, row: LightRow, schema?: PropertySchema): NoteRecord {
  const types = new Map((schema?.properties ?? []).map(d => [d.key, d.type]))
  const props: Record<string, PropertyValue> = {}
  for (const [key, raw] of Object.entries(row.values)) {
    const v = normalize(raw)
    props[key] = coercePropertyValue(v, types.get(key) ?? guessPropertyType(v))
  }
  return makeRecord({ id: row.id, base: baseId, path: '', title: row.title, props })
}
