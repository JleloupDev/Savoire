// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Manifeste d'une base : le contenu du document .base, dans son arbre
// partage (ctx.tree), sous root['base']. Tout se modifie a plusieurs en temps
// reel :
//
//   base: {
//     version: 1,
//     source:  { folder, filters, filterMode } dossier des lignes-pages, filtre
//     columns: { <cle>: { width, order, formula?, rollup? } }  proprietes
//                                             affichees ; une cle '=Nom' :
//                                             colonne formule ou rollup
//     views:   { <id>: { name, type, order, filters, filterMode, sorts, groupBy, hidden, totals } }
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
import { isTotalKind, type TotalKind } from './totals'
import { readFilters, type BaseFilterItem, type FilterMode } from './filters'
import { readRollup, type RollupDef } from './rollup'
import type { DateGrouping } from './groups'
import { readAutomations, readButton, readTemplateSettings, type AutomationDef, type ButtonDef, type TemplateSettings } from './structure'
import { BASE_LOT_COUNT } from '@savoire/plugin-api'
import type { ISharedTree, ITreeMap, TreeValue } from '@savoire/plugin-api'

/** Colonne du titre : toujours la premiere, jamais retiree. */
export const TITLE_COLUMN = '@title'

/** Une colonne formule a une cle qui commence par ce signe (jamais une propriete). */
export const FORMULA_PREFIX = '='

export function isFormulaKey(key: string): boolean {
  return key.startsWith(FORMULA_PREFIX)
}

export type { BaseFilter, BaseFilterGroup, BaseFilterItem, FilterMode } from './filters'

export interface BaseSort {
  key: string
  dir: 'asc' | 'desc'
}

export interface BaseColumn {
  key: string
  width: number
  order: number
  /** Colonne formule (cle '=Nom') : son expression, syntaxe Notion. */
  formula?: string
  /** Colonne rollup (cle '=Nom') : une propriete des lignes liees, resumee. */
  rollup?: RollupDef
  /** Colonne bouton (cle '=Nom') : des actions sur la ligne. */
  button?: ButtonDef
}

export type BaseViewType = 'table' | 'kanban' | 'list' | 'gallery' | 'calendar' | 'timeline' | 'chart' | 'form'

export const VIEW_TYPES: { type: BaseViewType; label: string; glyph: string }[] = [
  { type: 'table', label: 'Tableau', glyph: '▦' },
  { type: 'kanban', label: 'Kanban', glyph: '▤' },
  { type: 'list', label: 'Liste', glyph: '☰' },
  { type: 'gallery', label: 'Galerie', glyph: '▩' },
  { type: 'calendar', label: 'Calendrier', glyph: '▣' },
  { type: 'timeline', label: 'Frise', glyph: '▬' },
  { type: 'chart', label: 'Graphique', glyph: '▮' },
  { type: 'form', label: 'Formulaire', glyph: '✎' },
]

export type ChartKind = 'bar' | 'hbar' | 'line' | 'donut'
export type TimelineScale = 'day' | 'week' | 'month'

export interface BaseViewDef {
  id: string
  name: string
  type: BaseViewType
  order: number
  /** Filtres (groupes compris), reunis par filterMode. */
  filters: BaseFilterItem[]
  filterMode: FilterMode
  sorts: BaseSort[]
  /** Propriete de regroupement (colonnes du kanban, sections du tableau). '' : aucune. */
  groupBy: string
  /** Une date se groupe par jour, semaine, mois ou annee. '' : par valeur. */
  dateGroup: DateGrouping | ''
  /** Sous-groupes du kanban (couloirs). '' : aucun. */
  subGroupBy: string
  /** Groupes sans ligne masques. */
  hideEmpty: boolean
  /** Groupes replies (ids, groups.ts). */
  collapsed: string[]
  /** Calendrier, frise : la date des lignes ; frise : la date de fin (sinon la fin de la periode). */
  dateBy: string
  endBy: string
  /** Galerie, kanban : la propriete qui porte l'image de couverture. '' : aucune. */
  cover: string
  /** Galerie : taille des cartes. */
  cardSize: 'small' | 'medium' | 'large'
  /** Frise : echelle. */
  scale: TimelineScale
  /** Graphique : forme, valeur mesuree ('' : nombre de lignes) et son calcul. groupBy : l'axe. */
  chartKind: ChartKind
  chartY: string
  chartCalc: 'sum' | 'mean' | 'min' | 'max'
  /** Frise : relation « bloque » (fleches vers les lignes liees). '' : aucune. */
  dependsOn: string
  /** Tableau : colonnes figees a gauche (le nom compte pour une). */
  frozen: number
  /** Tableau : retour a la ligne dans les cellules. */
  wrap: boolean
  /** Ordre manuel des lignes (ids), quand la vue n'a pas de tri. Les autres suivent. */
  rowOrder: string[]
  /** Tableau : sous-elements, par une relation vers la meme base (le parent). '' : aucun. */
  subItems: string
  /** Vue liee : propre a une base integree dans une note, masquee dans les onglets de la base. */
  linked: boolean
  /** Colonnes masquees dans cette vue. */
  hidden: string[]
  /** Total en bas de chaque colonne (tableau) : cle -> calcul. */
  totals: Record<string, TotalKind>
}

export interface BaseManifest {
  /** true une fois ecrit dans le document. */
  stored: boolean
  source: { folder: string; filters: BaseFilterItem[]; filterMode: FilterMode }
  columns: BaseColumn[]
  views: BaseViewDef[]
  lotCount: number
  lots: number[]
  /** Structure verrouillee : colonnes et vues ne se modifient plus (les valeurs, si). */
  locked: boolean
  automations: AutomationDef[]
  templates: TemplateSettings
}

export const DEFAULT_WIDTH = 160
/** Ordre manuel : lignes retenues au plus (les autres suivent, par nom). */
export const MAX_MANUAL_ORDER = 5000
/** Cle de tri de l'ordre manuel (calculee dans le client). */
export const RANK_KEY = '=@rang'
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
  return {
    id, name, type, order, filters: [], filterMode: 'and', sorts: [], groupBy: '', dateGroup: '', subGroupBy: '', hideEmpty: false,
    collapsed: [], hidden: [], totals: {}, dateBy: '', endBy: '', cover: '', cardSize: 'medium', scale: 'day',
    chartKind: 'bar', chartY: '', chartCalc: 'sum', dependsOn: '', frozen: 0, wrap: false, rowOrder: [], subItems: '', linked: false,
  }
}

/** Manifeste par defaut d'une base neuve : le dossier qui porte son nom. */
export function defaultManifest(folder: string): BaseManifest {
  return {
    stored: false,
    source: { folder, filters: [], filterMode: 'and' },
    columns: [],
    views: [defaultView()],
    lotCount: BASE_LOT_COUNT,
    lots: [],
    locked: false,
    automations: [],
    templates: { defaultTemplate: '', repeats: {} },
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
      const formula = c.get('formula')
      const rollup = readRollup(json(c.get('rollup'), null))
      const button = readButton(json(c.get('button'), null))
      columns.push({
        key, width: num(c.get('width'), DEFAULT_WIDTH), order: num(c.get('order'), 0),
        ...(typeof formula === 'string' ? { formula } : {}),
        ...(rollup ? { rollup } : {}),
        ...(button ? { button } : {}),
      })
    }
  }
  columns.sort((a, b) => a.order - b.order || a.key.localeCompare(b.key))
  const views: BaseViewDef[] = []
  if (isMap(viewsMap)) {
    for (const id of viewsMap.keys()) {
      const v = viewsMap.get(id)
      if (!isMap(v)) continue
      const type = VIEW_TYPES.find(t => t.type === v.get('type'))?.type ?? 'table'
      views.push({
        id,
        name: str(v.get('name'), 'Vue'),
        type,
        order: num(v.get('order'), 0),
        filters: readFilters(json(v.get('filters'), [])),
        filterMode: v.get('filterMode') === 'or' ? 'or' : 'and',
        sorts: json(v.get('sorts'), []),
        groupBy: str(v.get('groupBy'), ''),
        dateGroup: (['day', 'week', 'month', 'year'] as const).find(d => d === v.get('dateGroup')) ?? '',
        subGroupBy: str(v.get('subGroupBy'), ''),
        hideEmpty: v.get('hideEmpty') === true,
        collapsed: json<unknown[]>(v.get('collapsed'), []).filter((x): x is string => typeof x === 'string'),
        dateBy: str(v.get('dateBy'), ''),
        endBy: str(v.get('endBy'), ''),
        cover: str(v.get('cover'), ''),
        cardSize: (['small', 'medium', 'large'] as const).find(x => x === v.get('cardSize')) ?? 'medium',
        scale: (['day', 'week', 'month'] as const).find(x => x === v.get('scale')) ?? 'day',
        chartKind: (['bar', 'hbar', 'line', 'donut'] as const).find(x => x === v.get('chartKind')) ?? 'bar',
        chartY: str(v.get('chartY'), ''),
        chartCalc: (['sum', 'mean', 'min', 'max'] as const).find(x => x === v.get('chartCalc')) ?? 'sum',
        dependsOn: str(v.get('dependsOn'), ''),
        frozen: Math.max(0, Math.min(10, Math.floor(num(v.get('frozen'), 0)))),
        wrap: v.get('wrap') === true,
        subItems: str(v.get('subItems'), ''),
        linked: v.get('linked') === true,
        rowOrder: json<unknown[]>(v.get('rowOrder'), []).filter((x): x is string => typeof x === 'string').slice(0, MAX_MANUAL_ORDER),
        hidden: json(v.get('hidden'), []),
        totals: readTotals(json(v.get('totals'), {})),
      })
    }
  }
  views.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
  return {
    stored: true,
    source: isMap(source)
      ? {
          folder: str(source.get('folder'), folder),
          filters: readFilters(json(source.get('filters'), [])),
          filterMode: source.get('filterMode') === 'or' ? 'or' : 'and',
        }
      : fallback.source,
    columns,
    views: views.length ? views : fallback.views,
    lotCount: num(base.get('lotCount'), BASE_LOT_COUNT),
    lots: isMap(lotsMap) ? lotsMap.keys().map(Number).filter(Number.isInteger).sort((a, b) => a - b) : [],
    locked: base.get('locked') === true,
    automations: readAutomations(json(base.get('automations'), [])),
    templates: readTemplateSettings(json(base.get('templates'), null)),
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
        source: { kind: 'map', entries: { folder: d.source.folder, filters: JSON.stringify(d.source.filters), filterMode: d.source.filterMode } },
        columns: {
          kind: 'map',
          entries: Object.fromEntries(d.columns.map(c => [c.key, {
            kind: 'map', entries: {
              width: c.width, order: c.order,
              ...(c.formula !== undefined ? { formula: c.formula } : {}),
              ...(c.rollup ? { rollup: JSON.stringify(c.rollup) } : {}),
              ...(c.button ? { button: JSON.stringify(c.button) } : {}),
            },
          }])),
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
      if (patch.filterMode !== undefined) s.set('filterMode', patch.filterMode)
    })
  }

  setColumn(key: string, patch: Partial<Omit<BaseColumn, 'key'>>): void {
    this.write(base => {
      const cols = this.child(base, 'columns')
      this.materialize(cols)
      let c = cols.get(key)
      if (!isMap(c)) {
        const max = Math.max(0, ...cols.keys().map(k => { const x = cols.get(k); return isMap(x) ? num(x.get('order'), 0) : 0 }))
        c = cols.set(key, { kind: 'map', entries: { width: DEFAULT_WIDTH, order: max + 1 } })
      }
      const m = c as ITreeMap
      if (patch.width !== undefined) m.set('width', Math.round(patch.width))
      if (patch.order !== undefined) m.set('order', patch.order)
      if (patch.formula !== undefined) m.set('formula', patch.formula)
      if (patch.rollup !== undefined) m.set('rollup', JSON.stringify(patch.rollup))
      if (patch.button !== undefined) m.set('button', JSON.stringify(patch.button))
    })
  }

  removeColumn(key: string): void {
    this.write(base => {
      const cols = this.child(base, 'columns')
      this.materialize(cols)
      cols.delete(key)
    })
  }

  /**
   * Aucune colonne de propriete enregistree : la vue montrait celles des
   * lignes (defaults) ; on les ecrit avant de modifier les colonnes.
   */
  private materialize(cols: ITreeMap): void {
    if (cols.keys().some(k => k !== TITLE_COLUMN && !isFormulaKey(k))) return
    for (const c of this.defaults().columns) {
      if (c.key === TITLE_COLUMN || isFormulaKey(c.key) || isMap(cols.get(c.key))) continue
      cols.set(c.key, { kind: 'map', entries: { width: c.width, order: c.order } })
    }
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

  setLocked(locked: boolean): void {
    this.write(base => base.set('locked', locked))
  }

  setAutomations(list: AutomationDef[]): void {
    this.write(base => base.set('automations', JSON.stringify(list)))
  }

  setTemplates(settings: TemplateSettings): void {
    this.write(base => base.set('templates', JSON.stringify(settings)))
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

function viewEntries(v: BaseViewDef): Record<string, string | number | boolean> {
  return {
    name: v.name,
    type: v.type,
    order: v.order,
    filters: JSON.stringify(v.filters),
    filterMode: v.filterMode,
    sorts: JSON.stringify(v.sorts),
    groupBy: v.groupBy,
    dateGroup: v.dateGroup,
    subGroupBy: v.subGroupBy,
    hideEmpty: v.hideEmpty,
    collapsed: JSON.stringify(v.collapsed),
    dateBy: v.dateBy,
    endBy: v.endBy,
    cover: v.cover,
    cardSize: v.cardSize,
    scale: v.scale,
    chartKind: v.chartKind,
    chartY: v.chartY,
    chartCalc: v.chartCalc,
    dependsOn: v.dependsOn,
    frozen: v.frozen,
    wrap: v.wrap,
    subItems: v.subItems,
    linked: v.linked,
    rowOrder: JSON.stringify(v.rowOrder.slice(0, MAX_MANUAL_ORDER)),
    hidden: JSON.stringify(v.hidden),
    totals: JSON.stringify(v.totals),
  }
}

/** Seuls les calculs connus : un manifeste d'une autre version ne casse rien. */
function readTotals(raw: unknown): Record<string, TotalKind> {
  const out: Record<string, TotalKind> = {}
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const [k, v] of Object.entries(raw)) if (isTotalKind(v)) out[k] = v
  }
  return out
}
