// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Bases Notion (sources de donnees, vues) -> bases Savoire (ADR-035). Pur.
//
// Une base Notion devient un document .base dont les lignes sont les notes
// de son dossier (plugin-base, ADR-027) ; les valeurs de chaque ligne vont
// dans son frontmatter. Ce module rend :
//   - les valeurs d'une ligne (propertyValues) ;
//   - les types des proprietes pour le vault (propertyDefs), avec les
//     couleurs des choix ;
//   - le manifeste de la base (baseManifestOf) : colonnes et vues.
//
// Types : statut (avec ses etapes), adresse web, e-mail, telephone,
// fichiers, numero unique (son prefixe), dates de creation et de
// modification, relation (vers la base importee, avec sa propriete en
// retour), format des nombres et couleurs des choix.
//
// Vues : tableau, kanban (et ses sous-groupes), liste, galerie, calendrier,
// frise, graphique et formulaire gardent leur disposition, leur nom, leurs
// filtres (« et », « ou », groupes imbriques, dates relatives), leurs tris,
// leur regroupement et leurs colonnes masquees. Une disposition inconnue
// devient un tableau, et le rapport le dit.
//
// Formules, rollups : leur valeur calculee par Notion, figee au moment de
// l'import (leur syntaxe ne se traduit pas a coup sur). Relations : des liens
// [[...]] vers les lignes importees.

import type { FilterOp, NumberFormat, PropertyDef, PropertyOption, PropertyType, PropertyValue, StatusGroup } from '@savoire/plugin-api'
import { normalizeId, plainText, type NotionRichText } from './notionBlocks'

/** Colonne du titre dans une base (plugin-base, TITLE_COLUMN). */
export const BASE_TITLE_COLUMN = '@title'

// ── Valeurs ───────────────────────────────────────────────────────────────

/** Une valeur de propriete d'une page de Notion. */
export interface NotionPropertyValue {
  id?: string
  type: string
  [key: string]: unknown
}

export interface PropertyValueContext {
  /** Cible [[...]] d'une page importee (chemin sans extension). Null : absente. */
  linkTarget(notionId: string): string | null
}

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null)

function dateOf(v: unknown): string | null {
  return str((v as { start?: unknown } | null | undefined)?.start)
}

function names(list: unknown): string[] {
  return Array.isArray(list) ? list.map(x => str((x as { name?: unknown })?.name)).filter((x): x is string => !!x) : []
}

/** Valeur d'une propriete -> valeur de frontmatter. Undefined : rien a ecrire. */
export function propertyValueOf(p: NotionPropertyValue, ctx: PropertyValueContext): PropertyValue | undefined {
  const v = p[p.type]
  switch (p.type) {
    case 'title': return undefined
    case 'rich_text': return plainText(v as NotionRichText[]) || undefined
    case 'number': return typeof v === 'number' ? v : undefined
    case 'checkbox': return v === true
    case 'select': case 'status': return str((v as { name?: unknown } | null)?.name) ?? undefined
    case 'multi_select': { const n = names(v); return n.length ? n : undefined }
    case 'date': return dateOf(v) ?? undefined
    case 'url': case 'email': case 'phone_number': return str(v) ?? undefined
    case 'people': {
      const n = Array.isArray(v) ? v.map(x => str((x as { name?: unknown })?.name) ?? str((x as { person?: { email?: unknown } })?.person?.email)).filter((x): x is string => !!x) : []
      return n.length ? n : undefined
    }
    case 'files': {
      const n = Array.isArray(v) ? v.map(x => str((x as { name?: unknown })?.name)).filter((x): x is string => !!x) : []
      return n.length ? n : undefined
    }
    case 'relation': {
      const targets = Array.isArray(v)
        ? v.map(x => str((x as { id?: unknown })?.id)).filter((x): x is string => !!x).map(id => ctx.linkTarget(normalizeId(id))).filter((x): x is string => !!x)
        : []
      return targets.length ? targets.map(t => `[[${t}]]`) : undefined
    }
    case 'formula': {
      const f = v as { type?: string; [k: string]: unknown } | null
      if (!f?.type) return undefined
      const r = f[f.type]
      if (f.type === 'date') return dateOf(r) ?? undefined
      if (typeof r === 'string') return r || undefined
      if (typeof r === 'number' || typeof r === 'boolean') return r
      return undefined
    }
    case 'rollup': {
      const r = v as { type?: string; [k: string]: unknown } | null
      if (!r?.type) return undefined
      const x = r[r.type]
      if (r.type === 'number') return typeof x === 'number' ? x : undefined
      if (r.type === 'date') return dateOf(x) ?? undefined
      if (r.type === 'array' && Array.isArray(x)) {
        const parts = x.map(item => propertyValueOf(item as NotionPropertyValue, ctx)).flatMap(val => (Array.isArray(val) ? val : val === undefined || val === null ? [] : [String(val)]))
        return parts.length ? parts : undefined
      }
      return undefined
    }
    case 'created_time': case 'last_edited_time': return str(v) ?? undefined
    case 'created_by': case 'last_edited_by': return str((v as { name?: unknown } | null)?.name) ?? undefined
    case 'unique_id': {
      // Le numero seul : le prefixe est dans le type de la propriete (PropertyDef.prefix).
      const u = v as { number?: unknown } | null
      return typeof u?.number === 'number' ? u.number : undefined
    }
    case 'verification': return str((v as { state?: unknown } | null)?.state) ?? undefined
    default: return undefined
  }
}

/** Titre d'une page (sa propriete de type title), ou ''. */
export function pageTitleOf(properties: Record<string, NotionPropertyValue> | undefined): string {
  for (const p of Object.values(properties ?? {})) if (p?.type === 'title') return plainText(p.title as NotionRichText[]).trim()
  return ''
}

/** Les valeurs d'une ligne, dans l'ordre du schema (titre exclu). */
export function propertyValues(properties: Record<string, NotionPropertyValue> | undefined, ctx: PropertyValueContext): [string, PropertyValue][] {
  const out: [string, PropertyValue][] = []
  for (const [key, p] of Object.entries(properties ?? {})) {
    if (!p) continue
    const v = propertyValueOf(p, ctx)
    if (v !== undefined) out.push([key, v])
  }
  return out
}

// ── Schema -> types des proprietes ───────────────────────────────────────

export interface NotionSchemaProperty {
  id: string
  name: string
  type: string
  [key: string]: unknown
}

/** Couleurs de Notion -> celles des options d'une base (les memes noms). */
const OPTION_COLORS: ReadonlySet<string> = new Set(['gray', 'brown', 'orange', 'yellow', 'green', 'blue', 'purple', 'pink', 'red'])

function optionColor(color: string | undefined): string | undefined {
  const c = (color ?? '').replace(/_background$/, '')
  return OPTION_COLORS.has(c) ? c : undefined
}

/** Etape d'un statut d'apres le nom de son groupe Notion (ou sa place). */
function statusGroupOf(name: string | undefined, index: number): StatusGroup {
  const n = (name ?? '').toLowerCase()
  if (/complete|done|termin|fini/.test(n)) return 'done'
  if (/progress|cours|doing/.test(n)) return 'doing'
  if (/to-?do|faire|not started/.test(n)) return 'todo'
  return (['todo', 'doing', 'done'] as const)[Math.min(2, index)]
}

function optionsOf(p: NotionSchemaProperty): PropertyOption[] | undefined {
  const conf = p[p.type] as { options?: { id?: string; name?: string; color?: string }[]; groups?: { name?: string; option_ids?: string[] }[] } | undefined
  const list = conf?.options
  if (!Array.isArray(list)) return undefined
  const groupOf = new Map<string, StatusGroup>()
  if (p.type === 'status' && Array.isArray(conf?.groups)) {
    conf!.groups.forEach((g, i) => { for (const id of g?.option_ids ?? []) groupOf.set(id, statusGroupOf(g?.name, i)) })
  }
  return list.filter(o => o?.name).map(o => {
    const color = optionColor(o.color)
    const out: PropertyOption = color ? { value: o.name!, color } : { value: o.name! }
    if (p.type === 'status') out.group = (o.id && groupOf.get(o.id)) || 'todo'
    return out
  })
}

const TYPE_OF: Record<string, PropertyType> = {
  number: 'number',
  checkbox: 'checkbox',
  select: 'select',
  status: 'status',
  multi_select: 'multiselect',
  date: 'date',
  created_time: 'created',
  last_edited_time: 'modified',
  relation: 'relation',
  rich_text: 'text',
  url: 'url',
  email: 'email',
  phone_number: 'phone',
  files: 'files',
  unique_id: 'id',
}

const NUMBER_FORMATS: Record<string, NumberFormat> = {
  number: 'number', number_with_commas: 'number', percent: 'percent',
  euro: 'euro', dollar: 'dollar', pound: 'pound', franc: 'franc', swiss_franc: 'franc',
}

export interface PropertyDefsContext {
  /** Id du document .base importe pour une source de donnees (ou base) Notion. */
  baseOf?(notionId: string): string | undefined
}

/** Types des proprietes d'une base, a declarer dans le vault. Le titre et les types sans equivalent sont laisses devines. */
export function propertyDefs(schema: Record<string, NotionSchemaProperty>, ctx: PropertyDefsContext = {}): PropertyDef[] {
  const out: PropertyDef[] = []
  for (const [name, p] of Object.entries(schema)) {
    const type = TYPE_OF[p.type]
    if (!type) continue
    const def: PropertyDef = { key: name, type }
    if (type === 'select' || type === 'multiselect' || type === 'status') {
      const options = optionsOf(p)
      if (options?.length) def.options = options
    }
    if (type === 'number') {
      const f = NUMBER_FORMATS[String((p.number as { format?: unknown } | undefined)?.format ?? '')]
      if (f && f !== 'number') def.format = f
    }
    if (type === 'id') {
      const prefix = (p.unique_id as { prefix?: unknown } | undefined)?.prefix
      if (typeof prefix === 'string' && prefix) def.prefix = prefix
    }
    if (type === 'relation') {
      const r = p.relation as { data_source_id?: string; database_id?: string; dual_property?: { synced_property_name?: string } } | undefined
      const target = r?.data_source_id ?? r?.database_id
      const base = target ? ctx.baseOf?.(normalizeId(target)) : undefined
      const back = r?.dual_property?.synced_property_name
      if (base) def.relation = { base, ...(back ? { back } : {}) }
    }
    out.push(def)
  }
  return out
}

// ── Vues -> manifeste ─────────────────────────────────────────────────────

/** Meme forme que les filtres d'une vue (plugin-base, filters.ts). */
export interface ImportedBaseFilter { key: string; op: FilterOp | 'within'; value?: PropertyValue }
export interface ImportedFilterGroup { mode: 'and' | 'or'; items: ImportedFilterItem[] }
export type ImportedFilterItem = ImportedBaseFilter | ImportedFilterGroup
export interface ImportedBaseSort { key: string; dir: 'asc' | 'desc' }

export type ImportedViewType = 'table' | 'kanban' | 'list' | 'gallery' | 'calendar' | 'timeline' | 'chart' | 'form'

/** Les reglages repris d'une vue (plugin-base, BaseViewDef) ; le reste prend sa valeur par defaut. */
export interface ImportedBaseView {
  id: string
  name: string
  type: ImportedViewType
  order: number
  filters: ImportedFilterItem[]
  filterMode: 'and' | 'or'
  sorts: ImportedBaseSort[]
  groupBy: string
  subGroupBy: string
  hidden: string[]
  totals: Record<string, never>
  dateBy: string
  endBy: string
  cover: string
}

export interface ImportedBaseManifest {
  columns: { key: string; width: number; order: number }[]
  views: ImportedBaseView[]
  /** Ce qui n'a pas pu etre repris (une phrase par cas). */
  warnings: string[]
}

/** Une vue telle que GET /v1/views/{id} la rend (champs lus seulement). */
export interface NotionView {
  id: string
  name?: string
  type?: string
  filter?: unknown
  sorts?: unknown
  configuration?: {
    properties?: { property_id?: string; property?: string; id?: string; visible?: boolean; width?: number }[]
    group_by?: { property_id?: string; property?: string; id?: string } | null
    [k: string]: unknown
  }
}

const OPS: Record<string, FilterOp> = {
  equals: 'eq', does_not_equal: 'neq', contains: 'contains', does_not_contain: 'neq', starts_with: 'startsWith',
  greater_than: 'gt', less_than: 'lt', greater_than_or_equal_to: 'gte', less_than_or_equal_to: 'lte',
  before: 'lt', after: 'gt', on_or_before: 'lte', on_or_after: 'gte',
  is_empty: 'empty', is_not_empty: 'notEmpty',
}

/** Periodes relatives des filtres de date de Notion. */
const RANGES: Record<string, string> = {
  past_week: '@pastWeek', past_month: '@pastMonth', past_year: '@pastYear',
  this_week: '@thisWeek', next_week: '@nextWeek', next_month: '@nextMonth', next_year: '@nextYear',
}

const VIEW_TYPES: Record<string, ImportedViewType> = {
  table: 'table', board: 'kanban', list: 'list', gallery: 'gallery', calendar: 'calendar', timeline: 'timeline', chart: 'chart', form: 'form',
}

class SchemaIndex {
  private readonly byId = new Map<string, NotionSchemaProperty>()
  private readonly byName = new Map<string, NotionSchemaProperty>()

  constructor(schema: Record<string, NotionSchemaProperty>) {
    for (const [name, p] of Object.entries(schema)) {
      const prop = { ...p, name: p.name || name }
      this.byName.set(prop.name, prop)
      if (p.id) this.byId.set(p.id, prop)
      if (p.id) this.byId.set(decodeURIComponentSafe(p.id), prop)
    }
  }

  private find(ref: string | undefined): NotionSchemaProperty | undefined {
    if (!ref) return undefined
    return this.byId.get(ref) ?? this.byId.get(decodeURIComponentSafe(ref)) ?? this.byName.get(ref)
  }

  /** Cle de la colonne (nom de la propriete, ou la colonne du titre). */
  key(ref: string | undefined): string | null {
    const p = this.find(ref)
    if (!p) return null
    return p.type === 'title' ? BASE_TITLE_COLUMN : p.name
  }

  type(ref: string | undefined): string | undefined {
    return this.find(ref)?.type
  }

  all(): NotionSchemaProperty[] {
    return [...this.byName.values()]
  }

  /** Premiere propriete d'un de ces types (dans l'ordre des types). */
  firstOf(...types: string[]): string {
    for (const t of types) {
      const p = this.all().find(x => x.type === t)
      if (p) return p.name
    }
    return ''
  }
}

function decodeURIComponentSafe(s: string): string {
  try { return decodeURIComponent(s) } catch { return s }
}

function refOf(x: { property_id?: string; property?: string; id?: string } | null | undefined): string | undefined {
  return x?.property_id ?? x?.property ?? x?.id
}

/** Un filtre simple de Notion -> filtre de base. Null : pas repris. */
function simpleFilter(f: Record<string, unknown>, schema: SchemaIndex): ImportedBaseFilter | null {
  const key = schema.key(typeof f.property === 'string' ? f.property : undefined)
  if (!key) return null
  for (const [k, cond] of Object.entries(f)) {
    if (k === 'property' || k === 'type' || typeof cond !== 'object' || cond === null) continue
    const entries = Object.entries(cond as Record<string, unknown>)
    if (entries.length !== 1) return null
    const [opName, raw] = entries[0]
    if (RANGES[opName]) return { key, op: 'within', value: RANGES[opName] }
    const op = OPS[opName]
    if (!op) return null
    if (op === 'empty' || op === 'notEmpty') return { key, op }
    if (typeof raw === 'string' || typeof raw === 'number' || typeof raw === 'boolean') {
      // Une date de Notion est en ISO complet ; un jour suffit a une base.
      const value = typeof raw === 'string' && /^\d{4}-\d{2}-\d{2}T00:00/.test(raw) ? raw.slice(0, 10) : raw
      return { key, op, value }
    }
    return null
  }
  return null
}

/** Filtre de Notion -> filtres et liaison d'une vue. Null : pas repris. */
function convertFilter(filter: unknown, schema: SchemaIndex, depth = 0): { mode: 'and' | 'or'; items: ImportedFilterItem[] } | null {
  if (!filter || typeof filter !== 'object') return { mode: 'and', items: [] }
  const f = filter as Record<string, unknown>
  const list = Array.isArray(f.and) ? f.and : Array.isArray(f.or) ? f.or : null
  if (!list) {
    const one = simpleFilter(f, schema)
    return one ? { mode: 'and', items: [one] } : null
  }
  const mode = Array.isArray(f.and) ? 'and' : 'or'
  const items: ImportedFilterItem[] = []
  for (const part of list) {
    if (!part || typeof part !== 'object') return null
    const p = part as Record<string, unknown>
    if (Array.isArray(p.and) || Array.isArray(p.or)) {
      // Un groupe dans un groupe : deux niveaux, comme Notion.
      if (depth >= 1) return null
      const inner = convertFilter(p, schema, depth + 1)
      if (!inner) return null
      if (inner.mode === mode || inner.items.length === 1) items.push(...inner.items)
      else items.push({ mode: inner.mode, items: inner.items })
      continue
    }
    const one = simpleFilter(p, schema)
    if (!one) return null
    items.push(one)
  }
  return { mode, items }
}

function convertSorts(sorts: unknown, schema: SchemaIndex): ImportedBaseSort[] {
  if (!Array.isArray(sorts)) return []
  const out: ImportedBaseSort[] = []
  for (const s of sorts as { property?: string; direction?: string }[]) {
    const key = schema.key(s?.property)
    if (key) out.push({ key, dir: s.direction === 'descending' ? 'desc' : 'asc' })
  }
  return out
}

/** Une propriete designee par l'un de ces champs de la configuration d'une vue. */
function configRef(conf: Record<string, unknown> | undefined, schema: SchemaIndex, ...fields: string[]): string {
  for (const f of fields) {
    const v = conf?.[f]
    const ref = typeof v === 'string' ? v : refOf(v as { property_id?: string; property?: string; id?: string } | null | undefined)
    const key = ref ? schema.key(ref) : null
    if (key && key !== BASE_TITLE_COLUMN) return key
  }
  return ''
}

/**
 * Manifeste d'une base : colonnes (ordre et largeur de la premiere vue, sinon
 * ordre du schema) et vues. Sans vue lisible : un tableau de toutes les
 * colonnes.
 */
export function baseManifestOf(name: string, schema: Record<string, NotionSchemaProperty>, views: readonly NotionView[]): ImportedBaseManifest {
  const index = new SchemaIndex(schema)
  const warnings: string[] = []
  const columns: ImportedBaseManifest['columns'] = []
  const seen = new Set<string>()
  const addColumn = (key: string, width?: number) => {
    if (seen.has(key) || key === BASE_TITLE_COLUMN) return
    seen.add(key)
    columns.push({ key, width: Math.round(width && width > 40 ? width : 160), order: columns.length + 1 })
  }
  for (const p of views[0]?.configuration?.properties ?? []) {
    const key = index.key(refOf(p))
    if (key) addColumn(key, p.width)
  }
  for (const p of index.all()) if (p.type !== 'title' && p.type !== 'button') addColumn(p.name)

  const out: ImportedBaseView[] = views.map((v, i) => {
    const conf = v.configuration
    let type: ImportedViewType = VIEW_TYPES[v.type ?? 'table'] ?? 'table'
    if (v.type && !VIEW_TYPES[v.type]) warnings.push(`Base « ${name} » : la vue « ${v.name || v.type} » (${v.type}) devient un tableau.`)
    const filter = convertFilter(v.filter, index)
    if (!filter) warnings.push(`Base « ${name} » : le filtre de la vue « ${v.name || 'sans nom'} » n'a pas pu être repris.`)
    const hidden = (conf?.properties ?? [])
      .filter(p => p.visible === false)
      .map(p => index.key(refOf(p)))
      .filter((k): k is string => !!k && k !== BASE_TITLE_COLUMN)
    const grouped = configRef(conf, index, 'group_by')
    let groupBy = type === 'kanban' || type === 'chart' || type === 'table' ? grouped : ''
    // Un kanban sans regroupement : la premiere propriete de statut ou de choix.
    if (type === 'kanban' && !groupBy) groupBy = index.firstOf('status', 'select')
    if (type === 'kanban' && !groupBy) type = 'table'
    if (type === 'chart' && !groupBy) groupBy = index.firstOf('status', 'select', 'multi_select', 'checkbox')
    const dated = type === 'calendar' || type === 'timeline'
    const dateBy = dated ? configRef(conf, index, 'date_property', 'date_property_id', 'calendar_by', 'timeline_by') || index.firstOf('date', 'created_time', 'last_edited_time') : ''
    if (dated && !dateBy) {
      warnings.push(`Base « ${name} » : la vue « ${v.name || v.type} » n'a pas de date, elle devient un tableau.`)
      type = 'table'
    }
    const coverRef = (conf?.cover as { type?: string; property_id?: string } | undefined)
    const cover = (type === 'gallery' || type === 'kanban') && coverRef?.type === 'property' ? index.key(coverRef.property_id) ?? '' : ''
    const label = VIEW_TYPES[v.type ?? ''] ? v.name?.trim() : undefined
    return {
      id: `v${i + 1}`,
      name: label || v.name?.trim() || (type === 'kanban' ? 'Tableau Kanban' : 'Tableau'),
      type,
      order: i,
      filters: filter?.items ?? [],
      filterMode: filter?.mode ?? 'and',
      sorts: convertSorts(v.sorts, index),
      groupBy,
      subGroupBy: type === 'kanban' ? configRef(conf, index, 'sub_group_by') : '',
      hidden,
      totals: {},
      dateBy,
      endBy: type === 'timeline' ? configRef(conf, index, 'end_date_property', 'end_date_property_id') : '',
      cover: cover === BASE_TITLE_COLUMN ? '' : cover,
    }
  })
  if (!out.length) {
    out.push({
      id: 'v1', name: 'Tableau', type: 'table', order: 0, filters: [], filterMode: 'and', sorts: [], groupBy: '', subGroupBy: '',
      hidden: [], totals: {}, dateBy: '', endBy: '', cover: '',
    })
  }
  return { columns, views: out, warnings }
}
