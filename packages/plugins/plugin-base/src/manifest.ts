// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Manifeste d'une base : le contenu du document .base, dans son arbre
// partage (ctx.tree), sous root['base']. Tout se modifie a plusieurs en temps
// reel :
//
//   base: {
//     version: 1,
//     source:  { folder, filters }            dossier des lignes-pages, filtre
//     columns: { <cle>: { width, order } }    proprietes affichees
//     views:   { <id>: { name, type, order, filters, sorts, groupBy, hidden } }
//     lotCount, lots: { <n>: true }           lots de lignes legeres (query.ts)
//   }
//
// Une colonne ou une vue est une carte sous sa cle : deux membres qui
// touchent deux colonnes ne s'ecrasent pas, et l'ordre est un nombre (pas de
// deplacement de noeud, qui n'existe pas dans l'arbre partage). Filtres, tris
// et colonnes masquees d'une vue sont des chaines JSON remplacees en bloc.
//
// Regle des documents CRDT neufs : un .base neuf est vide. La vue montre un
// manifeste par defaut, et ne l'ecrit qu'a la premiere modification.
import { BASE_LOT_COUNT } from '@savoire/plugin-api'
import type { FilterOp, ISharedTree, ITreeMap, PropertyValue, TreeValue } from '@savoire/plugin-api'

/** Colonne du titre : toujours la premiere, jamais retiree. */
export const TITLE_COLUMN = '@title'

export interface BaseFilter {
  /** Propriete, ou TITLE_COLUMN pour le nom de la ligne. */
  key: string
  op: FilterOp
  value?: PropertyValue
}

export interface BaseSort {
  key: string
  dir: 'asc' | 'desc'
}

export interface BaseColumn {
  key: string
  width: number
  order: number
}

export type BaseViewType = 'table' | 'kanban'

export interface BaseViewDef {
  id: string
  name: string
  type: BaseViewType
  order: number
  filters: BaseFilter[]
  sorts: BaseSort[]
  /** Propriete de regroupement (kanban). '' : aucune. */
  groupBy: string
  /** Colonnes masquees dans cette vue. */
  hidden: string[]
}

export interface BaseManifest {
  /** true une fois ecrit dans le document. */
  stored: boolean
  source: { folder: string; filters: BaseFilter[] }
  columns: BaseColumn[]
  views: BaseViewDef[]
  lotCount: number
  lots: number[]
}

export const DEFAULT_WIDTH = 160
export const TITLE_WIDTH = 240

function isMap(v: TreeValue | undefined): v is ITreeMap {
  return typeof v === 'object' && v !== null && v.kind === 'map'
}

function json<T>(v: TreeValue | undefined, fallback: T): T {
  if (typeof v !== 'string') return fallback
  try { return JSON.parse(v) as T } catch { return fallback }
}

function num(v: TreeValue | undefined, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback
}

function str(v: TreeValue | undefined, fallback: string): string {
  return typeof v === 'string' ? v : fallback
}

export function defaultView(id = 'v1', name = 'Tableau', type: BaseViewType = 'table', order = 0): BaseViewDef {
  return { id, name, type, order, filters: [], sorts: [], groupBy: '', hidden: [] }
}

/** Manifeste par defaut d'une base neuve : le dossier qui porte son nom. */
export function defaultManifest(folder: string): BaseManifest {
  return {
    stored: false,
    source: { folder, filters: [] },
    columns: [],
    views: [defaultView()],
    lotCount: BASE_LOT_COUNT,
    lots: [],
  }
}

/** Lit le manifeste dans l'arbre ; ce qui manque prend la valeur par defaut. */
export function readManifest(tree: ISharedTree | undefined, folder: string): BaseManifest {
  const fallback = defaultManifest(folder)
  const base = tree?.root.get('base')
  if (!isMap(base)) return fallback
  const source = base.get('source')
  const columnsMap = base.get('columns')
  const viewsMap = base.get('views')
  const lotsMap = base.get('lots')
  const columns: BaseColumn[] = []
  if (isMap(columnsMap)) {
    for (const key of columnsMap.keys()) {
      const c = columnsMap.get(key)
      if (!isMap(c)) continue
      columns.push({ key, width: num(c.get('width'), DEFAULT_WIDTH), order: num(c.get('order'), 0) })
    }
  }
  columns.sort((a, b) => a.order - b.order || a.key.localeCompare(b.key))
  const views: BaseViewDef[] = []
  if (isMap(viewsMap)) {
    for (const id of viewsMap.keys()) {
      const v = viewsMap.get(id)
      if (!isMap(v)) continue
      const type = v.get('type') === 'kanban' ? 'kanban' : 'table'
      views.push({
        id,
        name: str(v.get('name'), 'Vue'),
        type,
        order: num(v.get('order'), 0),
        filters: json(v.get('filters'), []),
        sorts: json(v.get('sorts'), []),
        groupBy: str(v.get('groupBy'), ''),
        hidden: json(v.get('hidden'), []),
      })
    }
  }
  views.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
  return {
    stored: true,
    source: isMap(source)
      ? { folder: str(source.get('folder'), folder), filters: json(source.get('filters'), []) }
      : fallback.source,
    columns,
    views: views.length ? views : fallback.views,
    lotCount: num(base.get('lotCount'), BASE_LOT_COUNT),
    lots: isMap(lotsMap) ? lotsMap.keys().map(Number).filter(Number.isInteger).sort((a, b) => a - b) : [],
  }
}

const TAG = Symbol('plugin-base/manifest')

/**
 * Ecritures du manifeste. Chaque modification est UNE transaction : les
 * autres membres la recoivent d'un bloc. La premiere ecrit d'abord la
 * structure par defaut (avec les colonnes que la vue montrait).
 */
export class ManifestStore {
  constructor(
    private readonly tree: ISharedTree | undefined,
    /** Manifeste montre avant la premiere ecriture (colonnes decouvertes comprises). */
    private readonly defaults: () => BaseManifest,
  ) {}

  get writable(): boolean {
    return !!this.tree
  }

  onChange(cb: () => void): () => void {
    return this.tree?.onChange(() => cb()) ?? (() => {})
  }

  private write(fn: (base: ITreeMap) => void): void {
    const tree = this.tree
    if (!tree) return
    tree.transact(() => fn(this.ensure(tree)), TAG)
  }

  private ensure(tree: ISharedTree): ITreeMap {
    const existing = tree.root.get('base')
    if (isMap(existing)) return existing
    const d = this.defaults()
    return tree.root.set('base', {
      kind: 'map',
      entries: {
        version: 1,
        source: { kind: 'map', entries: { folder: d.source.folder, filters: JSON.stringify(d.source.filters) } },
        columns: {
          kind: 'map',
          entries: Object.fromEntries(d.columns.map(c => [c.key, { kind: 'map', entries: { width: c.width, order: c.order } }])),
        },
        views: {
          kind: 'map',
          entries: Object.fromEntries(d.views.map(v => [v.id, { kind: 'map', entries: viewEntries(v) }])),
        },
        lotCount: d.lotCount,
        lots: { kind: 'map', entries: {} },
      },
    }) as ITreeMap
  }

  private child(base: ITreeMap, key: string): ITreeMap {
    const c = base.get(key)
    return isMap(c) ? c : base.set(key, { kind: 'map', entries: {} }) as ITreeMap
  }

  setSource(patch: Partial<BaseManifest['source']>): void {
    this.write(base => {
      const s = this.child(base, 'source')
      if (patch.folder !== undefined) s.set('folder', patch.folder)
      if (patch.filters !== undefined) s.set('filters', JSON.stringify(patch.filters))
    })
  }

  setColumn(key: string, patch: Partial<Omit<BaseColumn, 'key'>>): void {
    this.write(base => {
      const cols = this.child(base, 'columns')
      let c = cols.get(key)
      if (!isMap(c)) {
        const max = Math.max(0, ...cols.keys().map(k => { const x = cols.get(k); return isMap(x) ? num(x.get('order'), 0) : 0 }))
        c = cols.set(key, { kind: 'map', entries: { width: DEFAULT_WIDTH, order: max + 1 } })
      }
      const m = c as ITreeMap
      if (patch.width !== undefined) m.set('width', Math.round(patch.width))
      if (patch.order !== undefined) m.set('order', patch.order)
    })
  }

  removeColumn(key: string): void {
    this.write(base => this.child(base, 'columns').delete(key))
  }

  setView(id: string, patch: Partial<Omit<BaseViewDef, 'id'>>): void {
    this.write(base => {
      const views = this.child(base, 'views')
      let v = views.get(id)
      if (!isMap(v)) v = views.set(id, { kind: 'map', entries: viewEntries({ ...defaultView(id), ...patch }) })
      const m = v as ITreeMap
      for (const [k, value] of Object.entries(viewEntries({ ...defaultView(id), ...patch }))) {
        if ((patch as Record<string, unknown>)[k] !== undefined) m.set(k, value)
      }
    })
  }

  removeView(id: string): void {
    this.write(base => this.child(base, 'views').delete(id))
  }

  /** Note qu'un lot de lignes legeres existe (pour qu'on sache l'ouvrir). */
  markLot(n: number): void {
    const base = this.tree?.root.get('base')
    if (isMap(base)) {
      const lots = base.get('lots')
      if (isMap(lots) && lots.get(String(n)) === true) return
    }
    this.write(b => this.child(b, 'lots').set(String(n), true))
  }
}

function viewEntries(v: BaseViewDef): Record<string, string | number> {
  return {
    name: v.name,
    type: v.type,
    order: v.order,
    filters: JSON.stringify(v.filters),
    sorts: JSON.stringify(v.sorts),
    groupBy: v.groupBy,
    hidden: JSON.stringify(v.hidden),
  }
}
