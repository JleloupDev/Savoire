// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Lignes legeres d'une base : pas de note, juste des valeurs, rangees dans
// des LOTS (arbres annexes du document de la base, ctx.shared.openTree).
// Une carte `row:<id>` par ligne, le lot choisi par hachage de l'id : une
// base de 100 000 lignes ne charge que les lots qu'elle touche, et une
// cellule modifiee ne touche qu'un lot. Format : voir query.ts.
//
// La lecture (requetes, affichage) passe par api.query : l'index lit les lots
// lui-meme. Ici, seulement les ecritures, et la lecture d'une ligne entiere
// (promotion en page).
import { BASE_ROW_PREFIX, BASE_ROW_TITLE, baseLotName, baseLotOf } from '@savoire/plugin-api'
import type { DocumentSharedData, ISharedTree, ITreeMap, PropertyValue, TreeValue, TreeValueInit } from '@savoire/plugin-api'
import type { ManifestStore } from './manifest'

export interface LightRow {
  id: string
  title: string
  values: Record<string, PropertyValue>
}

function isMap(v: TreeValue | undefined): v is ITreeMap {
  return typeof v === 'object' && v !== null && v.kind === 'map'
}

function cellInit(value: PropertyValue): TreeValueInit {
  return Array.isArray(value) ? { kind: 'list', items: [...value] } : value
}

function cellValue(v: TreeValue | undefined): PropertyValue {
  if (v === undefined) return null
  if (typeof v === 'object' && v !== null) {
    if (v.kind === 'list') return v.toArray().filter((x): x is string => typeof x === 'string')
    if (v.kind === 'text') return v.toString()
    return null
  }
  return v
}

/** Lit une ligne dans sa carte de lot. */
export function readRow(id: string, map: ITreeMap): LightRow {
  const values: Record<string, PropertyValue> = {}
  let title = ''
  for (const key of map.keys()) {
    const v = cellValue(map.get(key))
    if (key === BASE_ROW_TITLE) title = v === null ? '' : String(v)
    else values[key] = v
  }
  return { id, title, values }
}

export function newRowId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto
  return c?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

export class LightRows {
  private readonly lots = new Map<number, Promise<ISharedTree>>()

  constructor(
    private readonly shared: DocumentSharedData | undefined,
    private readonly manifest: ManifestStore,
    private readonly lotCount: () => number,
  ) {}

  /** Le profil sait-il ouvrir les lots ? */
  get available(): boolean {
    return !!this.shared?.openTree && this.manifest.writable
  }

  private lot(n: number): Promise<ISharedTree> {
    let p = this.lots.get(n)
    if (!p) {
      if (!this.shared?.openTree) return Promise.reject(new Error('Lignes légères indisponibles sans synchronisation.'))
      p = this.shared.openTree(baseLotName(n))
      p.catch(() => this.lots.delete(n))
      this.lots.set(n, p)
    }
    return p
  }

  private lotOf(id: string): number {
    return baseLotOf(id, this.lotCount())
  }

  /**
   * La carte d'une ligne. Un lot qu'on vient d'ouvrir est vide : son etat
   * arrive juste apres (regle des arbres partages), on l'attend un peu.
   */
  private async rowMap(id: string, waitMs = 5000): Promise<{ tree: ISharedTree; row: ITreeMap | null }> {
    const tree = await this.lot(this.lotOf(id))
    const key = BASE_ROW_PREFIX + id
    const now = tree.root.get(key)
    if (isMap(now) || waitMs <= 0) return { tree, row: isMap(now) ? now : null }
    return new Promise(resolve => {
      const timer = setTimeout(() => { stop(); resolve({ tree, row: null }) }, waitMs)
      const stop = tree.onChange(() => {
        const r = tree.root.get(key)
        if (!isMap(r)) return
        clearTimeout(timer)
        stop()
        resolve({ tree, row: r })
      })
    })
  }

  /** Ajoute une ligne et rend son id. */
  async add(title: string, values: Record<string, PropertyValue> = {}): Promise<string> {
    const id = newRowId()
    const n = this.lotOf(id)
    const tree = await this.lot(n)
    const entries: Record<string, TreeValueInit> = { [BASE_ROW_TITLE]: title }
    for (const [k, v] of Object.entries(values)) if (v !== null && v !== undefined) entries[k] = cellInit(v)
    tree.transact(() => { tree.root.set(BASE_ROW_PREFIX + id, { kind: 'map', entries }) })
    // Le lot existe : l'index (et les autres membres) savent l'ouvrir.
    this.manifest.markLot(n)
    return id
  }

  /** Change une cellule (null : la vide). Seule cette cle de la ligne change. */
  async setCell(id: string, key: string, value: PropertyValue): Promise<void> {
    const { tree, row } = await this.rowMap(id)
    if (!row) throw new Error('Cette ligne n\'existe plus.')
    tree.transact(() => {
      if (value === null || (Array.isArray(value) && value.length === 0 && key !== BASE_ROW_TITLE)) row.delete(key)
      else row.set(key, cellInit(value))
    })
  }

  async get(id: string): Promise<LightRow | null> {
    const { row } = await this.rowMap(id)
    return row ? readRow(id, row) : null
  }

  async remove(id: string): Promise<void> {
    const tree = await this.lot(this.lotOf(id))
    tree.transact(() => tree.root.delete(BASE_ROW_PREFIX + id))
  }

  /** Libere les lots ouverts (fermeture de la vue). */
  close(): void {
    for (const n of this.lots.keys()) this.shared?.closeTree?.(baseLotName(n))
    this.lots.clear()
  }
}
