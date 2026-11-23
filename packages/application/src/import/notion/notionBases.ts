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
// Vues : tableau et tableau Kanban (board) gardent leur nom, leurs filtres
// simples, leurs tris, leur regroupement et leurs colonnes masquees. Les
// autres dispositions (calendrier, galerie, frise...) deviennent un tableau.
// Un filtre « ou », ou imbrique, n'est pas repris : la vue montre alors
// toutes les lignes, et le rapport le dit.
//
// Formules, rollups : leur valeur calculee par Notion, figee au moment de
// l'import. Relations : des liens [[...]] vers les lignes importees.

import type { FilterOp, PropertyDef, PropertyOption, PropertyType, PropertyValue } from '@savoire/plugin-api'
import { NOTION_TO_PAGE_COLOR, normalizeId, plainText, type NotionRichText } from './notionBlocks'

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
      const u = v as { prefix?: unknown; number?: unknown } | null
      if (typeof u?.number !== 'number') return undefined
      return u.prefix ? `${String(u.prefix)}-${u.number}` : u.number
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

function optionsOf(p: NotionSchemaProperty): PropertyOption[] | undefined {
  const list = (p[p.type] as { options?: { name?: string; color?: string }[] } | undefined)?.options
  if (!Array.isArray(list)) return undefined
  return list.filter(o => o?.name).map(o => {
    const color = NOTION_TO_PAGE_COLOR[o.color ?? '']
    return color ? { value: o.name!, color } : { value: o.name! }
  })
}

const TYPE_OF: Record<string, PropertyType> = {
  number: 'number',
  checkbox: 'checkbox',
  select: 'select',
  status: 'select',
  multi_select: 'multiselect',
  date: 'date',
  created_time: 'date',
  last_edited_time: 'date',
  relation: 'link',
  rich_text: 'text',
  url: 'text',
  email: 'text',
  phone_number: 'text',
}

/** Types des proprietes d'une base, a declarer dans le vault. Le titre et les types sans equivalent sont laisses devines. */
export function propertyDefs(schema: Record<string, NotionSchemaProperty>): PropertyDef[] {
  const out: PropertyDef[] = []
  for (const [name, p] of Object.entries(schema)) {
    const type = TYPE_OF[p.type]
    if (!type) continue
    const options = type === 'select' || type === 'multiselect' ? optionsOf(p) : undefined
    out.push(options?.length ? { key: name, type, options } : { key: name, type })
  }
  return out
}

// ── Vues -> manifeste ─────────────────────────────────────────────────────

export interface ImportedBaseFilter { key: string; op: FilterOp; value?: PropertyValue }
export interface ImportedBaseSort { key: string; dir: 'asc' | 'desc' }

/** Meme forme que BaseViewDef (plugin-base). */
export interface ImportedBaseView {
  id: string
  name: string
  type: 'table' | 'kanban'
  order: number
  filters: ImportedBaseFilter[]
  sorts: ImportedBaseSort[]
  groupBy: string
  hidden: string[]
  totals: Record<string, never>
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
  equals: 'eq', does_not_equal: 'neq', contains: 'contains', starts_with: 'startsWith',
  greater_than: 'gt', less_than: 'lt', greater_than_or_equal_to: 'gte', less_than_or_equal_to: 'lte',
  before: 'lt', after: 'gt', on_or_before: 'lte', on_or_after: 'gte',
  is_empty: 'empty', is_not_empty: 'notEmpty',
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

  /** Cle de la colonne (nom de la propriete, ou la colonne du titre). */
  key(ref: string | undefined): string | null {
    if (!ref) return null
    const p = this.byId.get(ref) ?? this.byId.get(decodeURIComponentSafe(ref)) ?? this.byName.get(ref)
    if (!p) return null
    return p.type === 'title' ? BASE_TITLE_COLUMN : p.name
  }

  all(): NotionSchemaProperty[] {
    return [...this.byName.values()]
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
    const op = OPS[opName]
    if (!op) return null
    if (op === 'empty' || op === 'notEmpty') return { key, op }
    if (typeof raw === 'string' || typeof raw === 'number' || typeof raw === 'boolean') return { key, op, value: raw }
    return null
  }
  return null
}

/** Filtre de Notion -> filtres de base (un « et » de filtres simples). Null : pas repris. */
function convertFilter(filter: unknown, schema: SchemaIndex): ImportedBaseFilter[] | null {
  if (!filter || typeof filter !== 'object') return []
  const f = filter as Record<string, unknown>
  if (Array.isArray(f.and)) {
    const out: ImportedBaseFilter[] = []
    for (const part of f.and) {
      if (part && typeof part === 'object' && Array.isArray((part as { and?: unknown }).and)) {
        const nested = convertFilter(part, schema)
        if (!nested) return null
        out.push(...nested)
        continue
      }
      const one = part && typeof part === 'object' ? simpleFilter(part as Record<string, unknown>, schema) : null
      if (!one) return null
      out.push(one)
    }
    return out
  }
  if (Array.isArray(f.or)) {
    // Un « ou » d'un seul element est un filtre simple.
    if (f.or.length === 1) return convertFilter(f.or[0], schema)
    return f.or.length === 0 ? [] : null
  }
  const one = simpleFilter(f, schema)
  return one ? [one] : null
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
    const kanban = v.type === 'board'
    if (v.type && v.type !== 'table' && v.type !== 'board') warnings.push(`Base « ${name} » : la vue « ${v.name || v.type} » (${v.type}) devient un tableau.`)
    let filters = convertFilter(v.filter, index)
    if (!filters) {
      warnings.push(`Base « ${name} » : le filtre de la vue « ${v.name || 'sans nom'} » n'a pas pu être repris.`)
      filters = []
    }
    const hidden = (v.configuration?.properties ?? [])
      .filter(p => p.visible === false)
      .map(p => index.key(refOf(p)))
      .filter((k): k is string => !!k && k !== BASE_TITLE_COLUMN)
    const groupBy = kanban ? index.key(refOf(v.configuration?.group_by ?? undefined)) ?? '' : ''
    return {
      id: `v${i + 1}`,
      name: v.name?.trim() || (kanban ? 'Tableau Kanban' : 'Tableau'),
      type: kanban && groupBy ? 'kanban' : 'table',
      order: i,
      filters,
      sorts: convertSorts(v.sorts, index),
      groupBy,
      hidden,
      totals: {},
    }
  })
  if (!out.length) out.push({ id: 'v1', name: 'Tableau', type: 'table', order: 0, filters: [], sorts: [], groupBy: '', hidden: [], totals: {} })
  return { columns, views: out, warnings }
}
