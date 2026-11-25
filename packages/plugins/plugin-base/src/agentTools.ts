// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Outils des agents apportes par les bases (ADR-033), sur le modele de ce que
// Notion offre pour ses bases de donnees :
//
//  - structure : base_list, base_describe (proprietes, types, premieres
//    lignes), base_create, base_update_schema (ajouter, renommer, changer le
//    type, retirer une propriete) ;
//  - donnees : base_add_rows, base_update_rows, base_delete_rows ;
//  - requetes : base_query (filtre, tris, pages avec curseur) ;
//  - base_set_cell : une cellule (outil d'origine, dans l'appli seulement).
//
// Ils tournent dans l'appli ET sur le pair indexeur (runtime 'server') :
// ChatGPT et Claude s'en servent par le MCP du serveur. Tout passe par la
// PluginAPI : le manifeste est l'arbre du document (openTree), les lignes
// legeres sont dans ses lots (sharedData), les lignes-pages sont des notes
// (frontmatter), les types sont ceux du vault (api.properties), les lectures
// passent par l'index (api.query, qui suit les ecritures avec un petit
// retard).
//
// L'application a deja verifie les droits de l'agent et dit s'il faut faire
// ou proposer. En mode proposition, une valeur de cellule devient une
// proposition « base.cell » (la meme que le mode suggestion) ; la structure
// ne se propose pas. Relations et rollups : plus tard.
import {
  BASE_ROW_TITLE, DEFAULT_STATUS_OPTIONS, PROPERTY_TYPES, baseLotOf, guessPropertyType, parseFrontmatter,
} from '@savoire/plugin-api'
import type {
  PluginAPI, PluginTool, PropertyDef, PropertyOption, PropertyType, PropertyValue, Query, QueryRow, QuerySource, ToolContext, ToolParamSchema,
} from '@savoire/plugin-api'
import { FILTER_OPS, MAX_SORTS, isTitleName, parseCell, parseFilter, parseSorts } from './agentArgs'
import { isoDay, mapFilterKeys, toWhere } from './filters'
import { DEFAULT_WIDTH, ManifestStore, TITLE_COLUMN, isFormulaKey, readManifest, type BaseColumn, type BaseManifest } from './manifest'
import { createPageRow, folderOfBase, renameNoteProperty, renamePageRow, writeNoteProperties } from './notes'
import { CELL_PROPOSAL, cellProposalType, type CellProposal } from './proposals'
import { LightRows } from './rows'

const RUNTIMES = ['app', 'server'] as const
/** Lignes ajoutees, modifiees ou supprimees par appel (comme Notion). */
const MAX_ROWS = 100
/** Lignes-pages (des notes) par appel : chacune est une ecriture a part. */
const MAX_PAGE_ROWS = 20
/** Notes reecrites par un renommage de propriete. */
const MAX_PAGE_RENAMES = 50
const MAX_PAGE_SIZE = 100
const DEFAULT_PAGE_SIZE = 25
/** Lignes lues pour connaitre les proprietes d'une base sans colonnes enregistrees. */
const SAMPLE = 50
const MAX_PROPERTIES = 50
/** Lignes lues au plus pour renommer une propriete. */
const MAX_RENAME_ROWS = 20_000

/** Types qu'un outil sait poser. Relation : plus tard. */
const TOOL_TYPES: readonly PropertyType[] = PROPERTY_TYPES.filter(t => t !== 'relation')
const CHOICE_TYPES: ReadonlySet<PropertyType> = new Set(['select', 'multiselect', 'status'])

type Args = Record<string, unknown>
interface BaseRef { id: string; path: string }

const isTrash = (path: string): boolean => path.startsWith('.trash/')

function baseRef(api: PluginAPI, ref: unknown): BaseRef {
  if (typeof ref !== 'string' || !ref.trim()) throw new Error('Donnez la base (chemin ou id).')
  const tree = (api.vault.getFileTree?.() ?? []).filter(f => !isTrash(f.path))
  const wanted = ref.trim().replace(/^\/+/, '')
  const hit = tree.find(f => f.docId === wanted || f.path === wanted || f.path.toLowerCase() === `${wanted.toLowerCase()}.base` || f.path.toLowerCase() === wanted.toLowerCase())
  if (!hit || !hit.path.endsWith('.base')) throw new Error(`Base introuvable : ${wanted}.`)
  return { id: hit.docId, path: hit.path }
}

async function rowsOf(api: PluginAPI, baseId: string, limit: number): Promise<{ rows: QueryRow[]; total: number }> {
  if (!api.query) throw new Error('Requêtes indisponibles.')
  const r = await api.query.query({ from: { base: baseId }, limit })
  return { rows: r.rows, total: r.total }
}

// ── Une base ouverte le temps d'un appel ─────────────────────────────────

interface Column extends BaseColumn {
  /** Type declare dans le vault, sinon devine sur une valeur. */
  type: PropertyType
  def?: PropertyDef
}

interface Schema {
  /** Proprietes de la base, dans l'ordre des colonnes. */
  columns: Column[]
  /** Colonnes calculees (formules, rollups, boutons) : lues dans l'appli seulement. */
  computed: string[]
  /** Premieres lignes, et leur nombre total. */
  sample: QueryRow[]
  total: number
}

interface OpenedBase extends BaseRef {
  /** Le manifeste du moment (relu dans l'arbre a chaque appel). */
  manifest(): BaseManifest
  store: ManifestStore
  rows: LightRows
  /** Les lignes de la base : ses lignes legeres et les notes de son dossier. */
  source(): QuerySource
  schema(): Promise<Schema>
}

function requireQuery(api: PluginAPI): NonNullable<PluginAPI['query']> {
  if (!api.query) throw new Error('Requêtes indisponibles.')
  return api.query
}

/**
 * Colonnes qu'une vue montrerait (view.ts, columnsOf) : sans colonne de
 * propriete enregistree, celles des lignes ; elles s'ecrivent a la premiere
 * modification de la structure.
 */
function shownColumns(m: BaseManifest, discovered: BaseColumn[]): BaseColumn[] {
  if (!m.stored) return discovered
  if (m.columns.some(c => c.key !== TITLE_COLUMN && !isFormulaKey(c.key))) return m.columns
  const max = Math.max(0, ...discovered.map(c => c.order))
  return [...discovered, ...m.columns.map(c => (c.key === TITLE_COLUMN ? c : { ...c, order: c.order + max }))]
}

async function withBase<T>(api: PluginAPI, ref: unknown, fn: (b: OpenedBase) => Promise<T>): Promise<T> {
  const base = ref && typeof ref === 'object' ? ref as BaseRef : baseRef(api, ref)
  // Sur le pair indexeur, les types du vault ne sont lus qu'a la demande.
  await api.properties?.ready?.()
  const tree = api.vault.openTree ? await api.vault.openTree(base.id) : undefined
  const folder = folderOfBase(base.path)
  const manifest = (): BaseManifest => readManifest(tree, folder)
  let known: BaseColumn[] | undefined
  let schema: Promise<Schema> | undefined
  const store = new ManifestStore(tree, () => { const m = manifest(); return { ...m, columns: known ?? m.columns } })
  const rows = new LightRows(tree ? api.vault.sharedData?.(base.id) : undefined, store, () => manifest().lotCount)
  const me = api.vault.getCurrentUser?.()?.id
  const source = (): QuerySource => {
    const m = manifest()
    const where = toWhere(m.source.filters, m.source.filterMode, { me, typeOf: k => api.properties?.get(k)?.type ?? guessPropertyType(null) })
    return { base: base.id, pages: { folder: m.source.folder.replace(/\/+$/, '') || undefined, ext: ['md'], ...(where ? { where } : {}) } }
  }
  const readSchema = async (): Promise<Schema> => {
    const r = await requireQuery(api).query({ from: source(), limit: SAMPLE })
    const seen = new Map<string, { count: number; sample: PropertyValue }>()
    for (const row of r.rows) {
      for (const [k, v] of Object.entries(row.values ?? {})) {
        const s = seen.get(k)
        if (s) { s.count++; if (s.sample === null) s.sample = v } else seen.set(k, { count: 1, sample: v })
      }
    }
    const discovered = [...seen.entries()].sort((a, b) => b[1].count - a[1].count).map(([key], i): BaseColumn => ({ key, width: DEFAULT_WIDTH, order: i + 1 }))
    const m = manifest()
    const stored = m.columns.filter(c => c.key !== TITLE_COLUMN && !isFormulaKey(c.key))
    // Ce qu'une vue ecrirait a la premiere modification : ses huit premieres colonnes decouvertes.
    known = shownColumns(m, discovered.slice(0, 8))
    return {
      columns: (stored.length ? stored : discovered).map(c => {
        const def = api.properties?.get(c.key)
        return { ...c, ...(def ? { def } : {}), type: def?.type ?? guessPropertyType(seen.get(c.key)?.sample ?? null) }
      }),
      computed: m.columns.filter(c => isFormulaKey(c.key)).map(c => c.key),
      sample: r.rows,
      total: r.total,
    }
  }
  try {
    return await fn({ ...base, manifest, store, rows, source, schema: () => schema ??= readSchema() })
  } finally {
    rows.close()
    if (tree) api.vault.closeTree?.(base.id)
  }
}

const sourcesOf = (b: BaseRef) => [{ docId: b.id, path: b.path }]
const isEmpty = (v: PropertyValue | undefined): boolean => v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0)
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)

/** Une ligne, pour l'IA : son nom, son id, ses valeurs. */
function rowLine(r: QueryRow, keys: readonly string[], all: boolean): string {
  const cells = keys.filter(k => all || !isEmpty(r.values?.[k])).map(k => `${k}: ${JSON.stringify(r.values?.[k] ?? null)}`)
  return `- ${r.title || r.id} (ligne ${r.id}${r.path ? `, page ${r.path}` : ''})${cells.length ? ` — ${cells.join(', ')}` : ''}`
}

function propertyLine(c: Column): string {
  const options = c.def?.options?.length ? ` : ${c.def.options.map(o => o.value).join(', ')}` : ''
  return `${c.key} (${c.type}${options})`
}

// ── Proprietes : noms, types, options ────────────────────────────────────

interface PropertySpec {
  key: string
  type: PropertyType
  options?: string[]
}

function propertyKey(raw: unknown, what = 'propriété'): string {
  const key = typeof raw === 'string' ? raw.trim() : ''
  if (!key) throw new Error(`Donnez le nom de la ${what}.`)
  if (key.length > 100 || /[:\n]/.test(key)) throw new Error(`Nom de propriété invalide : ${key} (100 caractères au plus, sans « : »).`)
  if (key.startsWith('=') || key.startsWith('@')) throw new Error(`Nom de propriété invalide : ${key} (pas de « = » ni de « @ » au début).`)
  if (key === BASE_ROW_TITLE) throw new Error('« title » est réservé au nom de la ligne : prenez un autre nom.')
  return key
}

function propertyType(raw: unknown, fallback?: PropertyType): PropertyType {
  if ((raw === undefined || raw === null) && fallback) return fallback
  if (raw === 'relation' || raw === 'rollup' || raw === 'formula') throw new Error(`Type « ${String(raw)} » : pas encore par ces outils, à faire dans Savoire.`)
  if (!TOOL_TYPES.includes(raw as PropertyType)) throw new Error(`Type inconnu : ${String(raw)}. Possibles : ${TOOL_TYPES.join(', ')}.`)
  return raw as PropertyType
}

function optionList(raw: unknown, type: PropertyType, key: string): string[] | undefined {
  if (raw === undefined || raw === null) return undefined
  if (!Array.isArray(raw) || !raw.every(x => typeof x === 'string' && x.trim())) throw new Error(`« ${key} » : options attend une liste de textes.`)
  if (!CHOICE_TYPES.has(type)) throw new Error(`« ${key} » : des options seulement pour select, multiselect et status.`)
  return [...new Set((raw as string[]).map(x => x.trim()))]
}

function propertySpec(raw: unknown): PropertySpec {
  const o = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as Args
  const key = propertyKey(o.name ?? o.property)
  const type = propertyType(o.type, 'text')
  const options = optionList(o.options, type, key)
  return { key, type, ...(options ? { options } : {}) }
}

function withOptions(existing: readonly PropertyOption[], add: readonly string[] | undefined, type: PropertyType): PropertyOption[] {
  const out = [...existing]
  for (const value of add ?? []) {
    if (!out.some(o => o.value === value)) out.push({ value, ...(type === 'status' ? { group: 'todo' as const } : {}) })
  }
  return !out.length && type === 'status' ? [...DEFAULT_STATUS_OPTIONS] : out
}

/**
 * Le type a declarer dans le vault pour cette propriete ; null : rien a
 * declarer. Un type vaut pour tout le vault : sans `change`, une propriete
 * deja typee autrement est refusee.
 */
function declaration(api: PluginAPI, spec: PropertySpec, change = false): PropertyDef | null {
  const existing = api.properties?.get(spec.key)
  if (existing && existing.type !== spec.type && !change) {
    throw new Error(`« ${spec.key} » est déjà une propriété du vault, de type ${existing.type} (un type vaut pour tout le vault). Gardez ce type, prenez un autre nom, ou changez-le avec l’opération set_type.`)
  }
  if (!existing && spec.type === 'text') return null
  if (!api.properties) throw new Error('Types de propriétés indisponibles ici.')
  const kept = existing?.type === spec.type
  const def: PropertyDef = kept ? { ...existing } : { key: spec.key, type: spec.type, ...(existing?.label ? { label: existing.label } : {}) }
  if (CHOICE_TYPES.has(spec.type)) {
    const options = withOptions(kept ? existing.options ?? [] : [], spec.options, spec.type)
    if (options.length) def.options = options
  }
  return kept && same(def, existing) ? null : def
}

/** Une valeur saisie dans un choix devient une option declaree (comme Notion et la vue). */
function declareOptions(api: PluginAPI, columns: readonly Column[], rows: readonly Record<string, PropertyValue>[]): void {
  for (const c of columns) {
    if (!c.def || !CHOICE_TYPES.has(c.def.type)) continue
    const used = rows.flatMap(r => { const v = r[c.key]; return Array.isArray(v) ? v : typeof v === 'string' && v ? [v] : [] })
    const options = withOptions(c.def.options ?? [], used, c.def.type)
    if (options.length !== (c.def.options ?? []).length) api.properties?.set({ ...c.def, options })
  }
}

// ── Lignes ───────────────────────────────────────────────────────────────

type FoundRow = { kind: 'light' | 'page'; id: string; path: string; title: string; values: Record<string, PropertyValue> }

function plainValue(v: unknown): PropertyValue {
  if (v === null || v === undefined) return null
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v
  if (Array.isArray(v)) return v.filter(x => x !== null && x !== undefined && typeof x !== 'object').map(String)
  return null
}

/**
 * Une ligne par son id, lue a la source (pas dans l'index, qui a un peu de
 * retard) : une note du dossier de la base, sinon une ligne legere.
 */
async function findRow(api: PluginAPI, b: OpenedBase, ref: string): Promise<FoundRow | null> {
  const file = (api.vault.getFileTree?.() ?? []).find(f => (f.docId === ref || f.path === ref) && !isTrash(f.path))
  const m = b.manifest()
  if (file) {
    const folder = m.source.folder.replace(/\/+$/, '')
    if (!/\.md$/i.test(file.path) || (folder && !file.path.startsWith(`${folder}/`))) throw new Error(`${file.path} n’est pas une ligne de ${b.path}.`)
    const fm = (parseFrontmatter(await api.vault.read(file.docId)) ?? {}) as Record<string, unknown>
    const name = file.path.slice(file.path.lastIndexOf('/') + 1).replace(/\.md$/i, '')
    return { kind: 'page', id: file.docId, path: file.path, title: name, values: Object.fromEntries(Object.entries(fm).map(([k, v]) => [k, plainValue(v)])) }
  }
  // Un lot que le manifeste ne connait pas n'existe pas : la ligne non plus.
  if (!m.lots.includes(baseLotOf(ref, m.lotCount)) || !b.rows.available) return null
  const row = await b.rows.find(ref)
  return row ? { kind: 'light', id: row.id, path: '', title: row.title, values: row.values } : null
}

async function findRows(api: PluginAPI, b: OpenedBase, refs: readonly string[]): Promise<FoundRow[]> {
  const found = await Promise.all(refs.map(ref => findRow(api, b, ref)))
  const missing = refs.filter((_, i) => !found[i])
  if (missing.length) throw new Error(`Ligne(s) introuvable(s) dans ${b.path} : ${missing.join(', ')}. Les ids sont ceux rendus par base_query.`)
  return found as FoundRow[]
}

const pad2 = (n: number): string => String(n).padStart(2, '0')
const nowStamp = (): string => { const d = new Date(); return `${isoDay(d)}T${pad2(d.getHours())}:${pad2(d.getMinutes())}` }

/** Valeurs posees a la creation de `n` lignes : numero unique, cree le, cree par... (comme la vue). */
async function creationValues(api: PluginAPI, b: OpenedBase, columns: readonly Column[], n: number): Promise<Record<string, PropertyValue>[]> {
  const out = Array.from({ length: n }, (): Record<string, PropertyValue> => ({}))
  const me = api.vault.getCurrentUser?.()?.id
  for (const c of columns) {
    switch (c.type) {
      case 'created': case 'modified': for (const o of out) o[c.key] = nowStamp(); break
      case 'createdBy': case 'modifiedBy': if (me) for (const o of out) o[c.key] = me; break
      case 'id': {
        const r = await requireQuery(api).query({ from: b.source(), aggregate: [{ op: 'max', field: { prop: c.key } }], limit: 1 }).catch(() => undefined)
        const max = r?.aggregates?.[0]
        const first = (typeof max === 'number' && Number.isFinite(max) ? Math.floor(max) : 0) + 1
        out.forEach((o, i) => { o[c.key] = first + i })
        break
      }
    }
  }
  return out
}

/** Modifie le / par, a chaque modification faite depuis la base. */
function touchValues(api: PluginAPI, columns: readonly Column[]): Record<string, PropertyValue> {
  const out: Record<string, PropertyValue> = {}
  const me = api.vault.getCurrentUser?.()?.id
  for (const c of columns) {
    if (c.type === 'modified') out[c.key] = nowStamp()
    else if (c.type === 'modifiedBy' && me) out[c.key] = me
  }
  return out
}

/** Les valeurs donnees pour une ligne, ramenees aux types des proprietes de la base. */
function cellValues(raw: unknown, s: Schema, b: BaseRef): Record<string, PropertyValue> {
  if (raw === undefined || raw === null) return {}
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error('values attend un objet { propriété: valeur }.')
  const keys = s.columns.map(c => c.key)
  const out: Record<string, PropertyValue> = {}
  for (const [k, v] of Object.entries(raw as Args)) {
    const key = k.trim()
    if (isTitleName(key, keys) || key === BASE_ROW_TITLE) throw new Error('Le nom de la ligne se donne dans title, pas dans values.')
    const col = s.columns.find(c => c.key === key)
    if (!col) throw new Error(`Propriété inconnue dans ${b.path} : ${key}. Propriétés : ${keys.join(', ') || '(aucune)'}. Ajoutez-la d’abord avec base_update_schema.`)
    out[key] = parseCell(key, col.def, v)
  }
  return out
}

function list(raw: unknown, what: string, max: number): unknown[] {
  if (!Array.isArray(raw) || !raw.length) throw new Error(`Donnez ${what}.`)
  if (raw.length > max) throw new Error(`Trop d’éléments (${raw.length}) : ${max} au plus par appel.`)
  return raw
}

function requireDirect(ctx: ToolContext, what: string): void {
  if (ctx.mode === 'propose') throw new Error(`En mode proposition, un agent ${what} : il faut le droit de le faire en direct.`)
}

// ── Schemas des parametres ────────────────────────────────────────────────

const BASE: ToolParamSchema = { type: 'string', description: 'La base : son chemin .base (l’extension peut manquer) ou son id.' }
const PROPERTY_TYPE: ToolParamSchema = { type: 'string', enum: [...TOOL_TYPES], description: 'Type de la propriété (text par défaut). select et status : un choix ; multiselect : plusieurs ; date : ISO 8601 ; id, created, modified, createdBy, modifiedBy : remplis par Savoire.' }
const OPTIONS: ToolParamSchema = { type: 'array', items: { type: 'string' }, description: 'Choix proposés (select, multiselect, status).' }
const VALUES: ToolParamSchema = { type: 'object', description: 'Valeurs par propriété : { "Prix": 12, "Statut": "Fait", "Tags": ["a", "b"], "Le": "2026-11-24" }. Texte, nombre, booléen ou liste de textes selon le type.' }
const FILTER = 'Filtre : { "property": "Prix", "op": "gt", "value": 10 }. Opérateurs : '
  + `${FILTER_OPS.join(', ')} (empty et not_empty sans value ; eq et contains sur une liste : « contient »). `
  + 'Combinable : { "and": [ ... ] } ou { "or": [ ... ] }, imbriqués. « Nom » filtre sur le nom de la ligne. Texte comparé sans casse ni accents ; une date se compare au jour.'

export function baseAgentTools(api: PluginAPI): PluginTool[] {
  const describe: PluginTool = {
    spec: {
      name: 'base_describe', title: 'Décrire une base', action: 'read', runtimes: [...RUNTIMES],
      description: 'La structure d’une base (.base) : ses propriétés, leurs types et choix, et ses premières lignes (id, nom, valeurs). À lire avant d’interroger ou de modifier une base. Pour chercher ou parcourir les lignes : base_query.',
      inputSchema: { type: 'object', properties: { base: BASE, limit: { type: 'integer', description: 'Lignes montrées (1 à 50, 10 par défaut).' } }, required: ['base'], additionalProperties: false },
    },
    async run(args) {
      const limit = Math.max(1, Math.min(SAMPLE, typeof args.limit === 'number' ? Math.floor(args.limit) : 10))
      return withBase(api, args.base, async b => {
        const s = await b.schema()
        const keys = s.columns.map(c => c.key)
        const rows = s.sample.slice(0, limit)
        const properties = ['Nom (titre)', ...s.columns.map(propertyLine), ...s.computed.map(k => `${k} (calculée)`)]
        return {
          text: [
            `${b.path} : ${s.total} ligne(s), colonnes ${keys.join(', ') || '(aucune)'}.`,
            `Propriétés : ${properties.join(' ; ')}.`,
            ...rows.map(r => rowLine(r, keys, true)),
          ].join('\n'),
          data: { keys, rows, properties: s.columns.map(c => ({ name: c.key, type: c.type, ...(c.def?.options?.length ? { options: c.def.options.map(o => o.value) } : {}) })) },
          sources: sourcesOf(b),
        }
      })
    },
  }

  const setCell: PluginTool = {
    spec: {
      name: 'base_set_cell', title: 'Changer une cellule de base', action: 'plugin',
      description: 'Change la valeur d’une cellule d’une base : la ligne (id rendu par base_describe), la colonne, la nouvelle valeur (vide : effacer).',
      inputSchema: {
        type: 'object',
        properties: {
          base: { type: 'string', description: 'Chemin ou id de la base.' },
          row: { type: 'string', description: 'Id de la ligne.' },
          column: { type: 'string', description: 'Nom de la colonne (propriété).' },
          value: { type: 'string', description: 'Nouvelle valeur (texte, nombre, date ISO). Vide : effacer.' },
        },
        required: ['base', 'row', 'column'],
        additionalProperties: false,
      },
    },
    async run(args, ctx) {
      const base = baseRef(api, args.base)
      const key = typeof args.column === 'string' ? args.column.trim() : ''
      if (!key) throw new Error('Donnez la colonne.')
      const { rows } = await rowsOf(api, base.id, 500)
      const row = rows.find(r => r.id === args.row || r.path === args.row)
      if (!row) throw new Error(`Ligne introuvable : ${String(args.row)}.`)
      const raw = args.value
      const after = (raw === undefined || raw === null || raw === '' ? null : typeof raw === 'number' || typeof raw === 'boolean' ? raw : String(raw)) as PropertyValue | null
      const before = (row.values?.[key] ?? null) as PropertyValue | null
      if (JSON.stringify(before) === JSON.stringify(after)) return { text: 'Rien à changer.' }
      const proposal: CellProposal = {
        row: row.path === '' ? { kind: 'light', baseId: base.id, rowId: row.id } : { kind: 'page', docId: row.id },
        title: row.title || row.id, key, before, after,
      }
      if (ctx.mode === 'propose') {
        if (!api.review) throw new Error('Révision indisponible.')
        const id = await api.review.propose(base.id, CELL_PROPOSAL, proposal, `${ctx.actor.agentName} propose ${key} = ${JSON.stringify(after)}`)
        return { text: `Proposition déposée dans la Révision de ${base.path} : ${row.title || row.id} · ${key}.`, data: { proposalId: id }, sources: [{ docId: base.id, path: base.path }] }
      }
      // Fait : le meme code que l'acceptation d'une proposition (verifie que la cellule n'a pas change).
      await cellProposalType(api).apply(base.id, proposal)
      return { text: `${base.path} : ${row.title || row.id} · ${key} = ${JSON.stringify(after)}.`, sources: [{ docId: base.id, path: base.path }] }
    },
  }

  const listBases: PluginTool = {
    spec: {
      name: 'base_list', title: 'Lister les bases', action: 'read', runtimes: [...RUNTIMES],
      description: 'Les bases du vault (fichiers .base, des tableaux de lignes à propriétés typées, comme les bases de données de Notion), éventuellement d’un dossier.',
      inputSchema: { type: 'object', properties: { folder: { type: 'string', description: 'Dossier (facultatif).' } }, additionalProperties: false },
    },
    async run(args) {
      const folder = typeof args.folder === 'string' ? args.folder.trim().replace(/^\/+|\/+$/g, '') : ''
      const prefix = folder ? `${folder.toLowerCase()}/` : ''
      const all = (api.vault.getFileTree?.() ?? [])
        .filter(f => /\.base$/i.test(f.path) && !isTrash(f.path) && f.path.toLowerCase().startsWith(prefix))
        .sort((a, b) => a.path.localeCompare(b.path))
      if (!all.length) return { text: folder ? `Aucune base dans ${folder}.` : 'Aucune base dans ce vault.' }
      const shown = all.slice(0, 200)
      return {
        text: `${all.length} base(s) :\n${shown.map(f => `- ${f.path}`).join('\n')}${all.length > shown.length ? `\n… et ${all.length - shown.length} autre(s).` : ''}`,
        sources: shown.slice(0, 20).map(f => ({ docId: f.docId, path: f.path })),
      }
    },
  }

  const query: PluginTool = {
    spec: {
      name: 'base_query', title: 'Interroger une base', action: 'read', runtimes: [...RUNTIMES],
      description: 'Les lignes d’une base, filtrées et triées, page par page. Rend pour chaque ligne son id (à donner à base_update_rows et base_delete_rows), son nom et ses valeurs, puis le nombre total et, s’il reste des lignes, un cursor : rappeler avec les mêmes filter et sorts et ce cursor pour la page suivante. Une ligne tout juste écrite peut mettre une ou deux secondes à apparaître.',
      inputSchema: {
        type: 'object',
        properties: {
          base: BASE,
          filter: { type: 'object', description: FILTER },
          sorts: {
            type: 'array', description: `Tris, dans l’ordre (${MAX_SORTS} au plus). Sans tri : par nom.`,
            items: { type: 'object', properties: { property: { type: 'string', description: 'Propriété, ou « Nom ».' }, direction: { type: 'string', enum: ['asc', 'desc'] } } },
          },
          page_size: { type: 'integer', description: `Lignes par page (1 à ${MAX_PAGE_SIZE}, ${DEFAULT_PAGE_SIZE} par défaut).` },
          cursor: { type: 'string', description: 'Suite d’une page précédente (rendu par cet outil), pour la même requête.' },
          properties: { type: 'array', items: { type: 'string' }, description: 'Propriétés à rendre (toutes par défaut).' },
        },
        required: ['base'], additionalProperties: false,
      },
    },
    async run(args) {
      return withBase(api, args.base, async b => {
        const s = await b.schema()
        const keys = s.columns.map(c => c.key)
        const typeOf = (k: string): PropertyType => api.properties?.get(k)?.type ?? s.columns.find(c => c.key === k)?.type ?? guessPropertyType(null)
        const actx = { keys, typeOf, me: api.vault.getCurrentUser?.()?.id }
        const filter = parseFilter(args.filter, actx)
        const sort = parseSorts(args.sorts, actx)
        const limit = Math.max(1, Math.min(MAX_PAGE_SIZE, typeof args.page_size === 'number' ? Math.floor(args.page_size) : DEFAULT_PAGE_SIZE))
        const select = Array.isArray(args.properties) ? args.properties.filter((x): x is string => typeof x === 'string' && !!x.trim()).map(x => x.trim()) : []
        const q: Query = {
          from: b.source(), sort, limit,
          ...(filter.where ? { where: filter.where } : {}),
          ...(select.length ? { select } : {}),
          ...(typeof args.cursor === 'string' && args.cursor ? { cursor: args.cursor } : {}),
        }
        const r = await requireQuery(api).query(q).catch((err: unknown) => {
          const e = err as { code?: string; message?: string }
          if (e?.code === 'invalid_cursor') throw new Error('Curseur invalide : il ne vaut que pour la même requête (mêmes filter, sorts et page_size). Reprenez sans cursor.')
          throw new Error(e?.message ? `Requête refusée : ${e.message}` : 'Requête refusée.')
        })
        const unknown = r.total === 0 ? filter.properties.filter(k => !keys.includes(k)) : []
        const shown = select.length ? select : keys
        return {
          text: [
            `${b.path} : ${r.rows.length} ligne(s) sur ${r.total}.`,
            ...r.rows.map(row => rowLine(row, shown, false)),
            ...(unknown.length ? [`Propriété(s) inconnue(s) de cette base : ${unknown.join(', ')}. Propriétés : ${keys.join(', ') || '(aucune)'}.`] : []),
            ...(r.next ? [`Suite : même appel, avec cursor "${r.next}".`] : []),
          ].join('\n'),
          data: { rows: r.rows, total: r.total, ...(r.next ? { next: r.next } : {}) },
          sources: sourcesOf(b),
        }
      })
    },
  }

  const create: PluginTool = {
    spec: {
      name: 'base_create', title: 'Créer une base', action: 'create', runtimes: [...RUNTIMES],
      description: 'Crée une base (fichier .base) avec ses propriétés typées. Chaque ligne a toujours un nom (le titre) : ne pas le déclarer. Remplir ensuite avec base_add_rows. Un type de propriété vaut pour tout le vault : un nom déjà typé autrement ailleurs est refusé. Une base se crée toujours ainsi, jamais par une note.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Chemin de la base : « Projets/Tâches » (l’extension .base est ajoutée).' },
          properties: {
            type: 'array', description: `Propriétés, dans l’ordre des colonnes (${MAX_PROPERTIES} au plus).`,
            items: { type: 'object', properties: { name: { type: 'string', description: 'Nom de la propriété.' }, type: PROPERTY_TYPE, options: OPTIONS } },
          },
        },
        required: ['path'], additionalProperties: false,
      },
    },
    async run(args, ctx) {
      const raw = typeof args.path === 'string' ? args.path.trim().replace(/^\/+|\/+$/g, '') : ''
      if (!raw || raw.split('/').some(part => !part.trim() || part === '..')) throw new Error('Donnez le chemin de la base (« Dossier/Nom »).')
      const path = /\.base$/i.test(raw) ? raw : `${raw}.base`
      if (isTrash(path)) throw new Error('Pas de base dans la corbeille.')
      const specs = args.properties === undefined || args.properties === null ? [] : list(args.properties, 'les propriétés', MAX_PROPERTIES).map(propertySpec)
      const dup = specs.find((p, i) => specs.findIndex(x => x.key === p.key) !== i)
      if (dup) throw new Error(`Propriété donnée deux fois : ${dup.key}.`)
      requireDirect(ctx, 'ne crée pas de base')
      if (api.vault.resolveDocumentId(path) || (api.vault.getFileTree?.() ?? []).some(f => f.path.toLowerCase() === path.toLowerCase())) {
        throw new Error(`Un document existe déjà : ${path}.`)
      }
      if (typeof api.vault.createFile !== 'function') throw new Error('Ce vault ne permet pas de créer de document.')
      await api.properties?.ready?.()
      // Tout est verifie avant de creer : types du vault compris.
      const defs = specs.map(p => declaration(api, p))
      const folder = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''
      if (folder) await api.vault.createFolder?.(folder)
      await api.vault.createFile(path)
      const base = { id: await idAfterCreate(api, path), path }
      if (specs.length) {
        await withBase(api, base, async b => {
          if (!b.store.writable) throw new Error('Base indisponible sans synchronisation du vault.')
          for (const def of defs) if (def) api.properties?.set(def)
          for (const p of specs) b.store.setColumn(p.key, {})
        })
      }
      return {
        text: `Base créée : ${path}${specs.length ? `, propriétés ${specs.map(p => `${p.key} (${p.type})`).join(', ')}` : ''}.`,
        data: { id: base.id, path },
        sources: sourcesOf(base),
      }
    },
  }

  const updateSchema: PluginTool = {
    spec: {
      name: 'base_update_schema', title: 'Modifier la structure d’une base', action: 'edit', runtimes: [...RUNTIMES],
      description: 'Modifie les propriétés d’une base, par une liste d’opérations faites dans l’ordre : add (ajouter une propriété typée), rename (la renommer, dans toutes les lignes), set_type (changer son type ou ses choix : vaut pour tout le vault, les valeurs ne sont pas converties), delete (la retirer de la base : les valeurs restent dans les lignes). Le nom de la ligne ne se modifie pas ici. Lire la structure avant : base_describe.',
      inputSchema: {
        type: 'object',
        properties: {
          base: BASE,
          operations: {
            type: 'array', description: 'Opérations, dans l’ordre.',
            items: {
              type: 'object',
              properties: {
                op: { type: 'string', enum: ['add', 'rename', 'set_type', 'delete'] },
                property: { type: 'string', description: 'La propriété visée (add : son nom).' },
                name: { type: 'string', description: 'rename : le nouveau nom.' },
                type: PROPERTY_TYPE,
                options: OPTIONS,
              },
            },
          },
        },
        required: ['base', 'operations'], additionalProperties: false,
      },
    },
    async run(args, ctx) {
      const ops = list(args.operations, 'les opérations', MAX_PROPERTIES).map(x => (x && typeof x === 'object' ? x : {}) as Args)
      requireDirect(ctx, 'ne change pas la structure d’une base')
      return withBase(api, args.base, async b => {
        if (!b.store.writable) throw new Error('Base indisponible sans synchronisation du vault.')
        if (b.manifest().locked) throw new Error(`La structure de ${b.path} est verrouillée : la déverrouiller dans Savoire.`)
        const s = await b.schema()
        // La structure telle qu'elle sera apres chaque operation : tout est verifie avant d'ecrire.
        const cols = s.columns.map(c => ({ ...c }))
        const has = (key: string): boolean => cols.some(c => c.key === key)
        const must = (key: string): Column => {
          const c = cols.find(x => x.key === key)
          if (!c) throw new Error(`Propriété inconnue dans ${b.path} : ${key}. Propriétés : ${cols.map(x => x.key).join(', ') || '(aucune)'}.`)
          return c
        }
        const steps: (() => Promise<void>)[] = []
        const done: string[] = []
        for (const o of ops) {
          switch (o.op) {
            case 'add': {
              const p = propertySpec({ name: o.property, type: o.type, options: o.options })
              if (has(p.key)) throw new Error(`La propriété existe déjà dans ${b.path} : ${p.key}.`)
              const def = declaration(api, p)
              cols.push({ key: p.key, width: DEFAULT_WIDTH, order: 0, type: p.type, ...(def ? { def } : {}) })
              steps.push(async () => { if (def) api.properties?.set(def); b.store.setColumn(p.key, {}) })
              done.push(`Ajoutée : ${p.key} (${p.type}).`)
              break
            }
            case 'set_type': {
              const col = must(propertyKey(o.property))
              const type = propertyType(o.type, col.type)
              const def = declaration(api, { key: col.key, type, options: optionList(o.options, type, col.key) }, true)
              col.type = type
              if (def) col.def = def
              steps.push(async () => { if (def) api.properties?.set(def) })
              done.push(`Type : ${col.key} est ${type}${def?.options?.length ? ` (${def.options.map(x => x.value).join(', ')})` : ''}, pour tout le vault.`)
              break
            }
            case 'delete': {
              const col = must(propertyKey(o.property))
              cols.splice(cols.indexOf(col), 1)
              steps.push(async () => b.store.removeColumn(col.key))
              done.push(`Retirée de la base : ${col.key} (ses valeurs restent dans les lignes).`)
              break
            }
            case 'rename': {
              const col = must(propertyKey(o.property))
              const from = col.key
              const to = propertyKey(o.name, 'propriété (name : le nouveau nom)')
              if (from === to) break
              if (has(to)) throw new Error(`La propriété existe déjà dans ${b.path} : ${to}.`)
              const rows = await rowsWith(api, b, from)
              const pages = rows.filter(r => r.path !== '')
              if (pages.length > MAX_PAGE_RENAMES) throw new Error(`Renommer ${from} réécrirait ${pages.length} notes : ${MAX_PAGE_RENAMES} au plus par ces outils, à faire dans Savoire.`)
              col.key = to
              steps.push(() => renameProperty(api, b, { ...col, key: from }, to, rows))
              done.push(`Renommée : ${from} devient ${to} (${rows.length} ligne(s)).`)
              break
            }
            default:
              throw new Error(`Opération inconnue : ${String(o.op)}. Possibles : add, rename, set_type, delete.`)
          }
        }
        for (const step of steps) await step()
        if (!done.length) return { text: `Rien à changer dans ${b.path}.`, sources: sourcesOf(b) }
        return { text: `${b.path}, structure modifiée :\n${done.map(d => `- ${d}`).join('\n')}`, sources: sourcesOf(b) }
      })
    },
  }

  const addRows: PluginTool = {
    spec: {
      name: 'base_add_rows', title: 'Ajouter des lignes à une base', action: 'create', runtimes: [...RUNTIMES],
      description: `Ajoute des lignes à une base (${MAX_ROWS} au plus par appel). Chaque ligne : un nom (title) et des valeurs pour des propriétés de la base (voir base_describe ; une propriété inconnue est refusée). Rend l’id de chaque ligne. Par défaut des lignes légères, sans note ; page: true crée une note par ligne, pour y écrire du texte (${MAX_PAGE_ROWS} au plus). Tout est vérifié avant d’écrire : une erreur n’ajoute rien.`,
      inputSchema: {
        type: 'object',
        properties: {
          base: BASE,
          rows: {
            type: 'array', description: 'Les lignes.',
            items: { type: 'object', properties: { title: { type: 'string', description: 'Nom de la ligne.' }, values: VALUES } },
          },
          page: { type: 'boolean', description: 'true : chaque ligne est une note du dossier de la base (faux par défaut).' },
        },
        required: ['base', 'rows'], additionalProperties: false,
      },
    },
    async run(args, ctx) {
      const asPage = args.page === true
      const raws = list(args.rows, 'les lignes (rows)', asPage ? MAX_PAGE_ROWS : MAX_ROWS)
      requireDirect(ctx, 'n’ajoute pas de ligne')
      return withBase(api, args.base, async b => {
        const s = await b.schema()
        const specs = raws.map(x => {
          const o = (x && typeof x === 'object' && !Array.isArray(x) ? x : {}) as Args
          const title = typeof o.title === 'string' && o.title.trim() ? o.title.trim() : 'Sans titre'
          const values = Object.fromEntries(Object.entries(cellValues(o.values, s, b)).filter(([, v]) => v !== null))
          return { title, values }
        })
        if (!asPage && !b.rows.available) throw new Error('Lignes légères indisponibles ici : ajoutez des pages (page: true).')
        const auto = await creationValues(api, b, s.columns, specs.length)
        declareOptions(api, s.columns, specs.map(x => x.values))
        const added: { id: string; path: string; title: string }[] = []
        if (asPage) {
          const folder = b.manifest().source.folder
          for (const [i, x] of specs.entries()) {
            const page = await createPageRow(api.vault, folder, x.title, { ...auto[i], ...x.values })
            added.push({ ...page, title: x.title })
          }
        } else {
          const ids = await Promise.all(specs.map((x, i) => b.rows.add(x.title, { ...auto[i], ...x.values })))
          ids.forEach((id, i) => added.push({ id, path: '', title: specs[i]!.title }))
        }
        return {
          text: `${added.length} ligne(s) ajoutée(s) à ${b.path} :\n${added.map(r => `- ${r.title} (ligne ${r.id}${r.path ? `, page ${r.path}` : ''})`).join('\n')}`,
          data: { rows: added },
          sources: sourcesOf(b),
        }
      })
    },
  }

  const updateRows: PluginTool = {
    spec: {
      name: 'base_update_rows', title: 'Modifier des lignes d’une base', action: 'edit', runtimes: [...RUNTIMES],
      description: `Modifie des lignes d’une base (${MAX_ROWS} au plus par appel) : pour chaque ligne, son id (rendu par base_query), et ce qui change : values (les propriétés données seulement ; null efface la cellule) et, au besoin, title (son nouveau nom). Tout est vérifié avant d’écrire. Selon les droits de l’agent, chaque cellule est changée, ou proposée dans la Révision.`,
      inputSchema: {
        type: 'object',
        properties: {
          base: BASE,
          rows: {
            type: 'array', description: 'Les lignes à modifier.',
            items: { type: 'object', properties: { row: { type: 'string', description: 'Id de la ligne.' }, title: { type: 'string', description: 'Nouveau nom (facultatif).' }, values: VALUES } },
          },
        },
        required: ['base', 'rows'], additionalProperties: false,
      },
    },
    async run(args, ctx) {
      const raws = list(args.rows, 'les lignes (rows)', MAX_ROWS).map(x => (x && typeof x === 'object' && !Array.isArray(x) ? x : {}) as Args)
      return withBase(api, args.base, async b => {
        const s = await b.schema()
        const refs = raws.map(o => (typeof o.row === 'string' ? o.row.trim() : ''))
        if (refs.some(r => !r)) throw new Error('Chaque ligne à modifier donne son id (row).')
        if (new Set(refs).size !== refs.length) throw new Error('Une ligne est donnée deux fois.')
        const found = await findRows(api, b, refs)
        const edits = found.map((row, i) => {
          const values = Object.fromEntries(Object.entries(cellValues(raws[i]!.values, s, b)).filter(([k, v]) => !same(row.values[k], v)))
          const asked = raws[i]!.title
          const title = typeof asked === 'string' && asked.trim() && asked.trim() !== row.title ? asked.trim() : undefined
          return { row, values, title }
        }).filter(e => e.title !== undefined || Object.keys(e.values).length > 0)
        const cells = edits.reduce((n, e) => n + Object.keys(e.values).length + (e.title !== undefined ? 1 : 0), 0)
        if (!cells) return { text: `Rien à changer dans ${b.path}.`, sources: sourcesOf(b) }

        if (ctx.mode === 'propose') {
          if (!api.review) throw new Error('Révision indisponible.')
          if (cells > MAX_ROWS) throw new Error(`Trop de cellules à proposer (${cells}) : ${MAX_ROWS} au plus par appel.`)
          const ids: string[] = []
          for (const e of edits) {
            const row: CellProposal['row'] = e.row.kind === 'light' ? { kind: 'light', baseId: b.id, rowId: e.row.id } : { kind: 'page', docId: e.row.id, path: e.row.path }
            const name = e.row.title || e.row.id
            const all: [string, PropertyValue | null, PropertyValue | null][] = [
              ...(e.title !== undefined ? [[TITLE_COLUMN, e.row.title, e.title] as [string, PropertyValue, PropertyValue]] : []),
              ...Object.entries(e.values).map(([k, v]): [string, PropertyValue | null, PropertyValue | null] => [k, e.row.values[k] ?? null, v]),
            ]
            for (const [key, before, after] of all) {
              const proposal: CellProposal = { row, title: name, key, before, after }
              ids.push(await api.review.propose(b.id, CELL_PROPOSAL, proposal, `${ctx.actor.agentName} propose ${key === TITLE_COLUMN ? 'Nom' : key} = ${JSON.stringify(after)}`))
            }
          }
          return { text: `${ids.length} proposition(s) déposée(s) dans la Révision de ${b.path} (${edits.length} ligne(s)).`, data: { proposalIds: ids }, sources: sourcesOf(b) }
        }

        const pages = edits.filter(e => e.row.kind === 'page').length
        if (pages > MAX_PAGE_ROWS) throw new Error(`Trop de lignes-pages à modifier (${pages}) : ${MAX_PAGE_ROWS} au plus par appel.`)
        declareOptions(api, s.columns, edits.map(e => e.values))
        const touch = touchValues(api, s.columns)
        for (const e of edits) {
          if (e.row.kind === 'light') {
            await b.rows.setCells(e.row.id, { ...e.values, ...touch, ...(e.title !== undefined ? { [BASE_ROW_TITLE]: e.title } : {}) })
            continue
          }
          const values = Object.fromEntries(Object.entries({ ...e.values, ...touch }).map(([k, v]) => [k, v === null ? undefined : v]))
          if (Object.keys(values).length) await writeNoteProperties(api.vault, e.row.id, values)
          // Renommer une ligne-page : c'est renommer sa note (les liens suivent).
          if (e.title !== undefined) await renamePageRow(api.vault, e.row.id, e.row.path, e.title)
        }
        return { text: `${edits.length} ligne(s) modifiée(s) dans ${b.path} (${cells} cellule(s)).`, sources: sourcesOf(b) }
      })
    },
  }

  const deleteRows: PluginTool = {
    spec: {
      name: 'base_delete_rows', title: 'Supprimer des lignes d’une base', action: 'delete', runtimes: [...RUNTIMES],
      description: `Supprime des lignes d’une base par leur id (rendu par base_query ; ${MAX_ROWS} au plus par appel). Une ligne légère est effacée ; une ligne-page (une note) va à la corbeille. Une ligne introuvable : rien n’est supprimé.`,
      inputSchema: {
        type: 'object',
        properties: { base: BASE, rows: { type: 'array', items: { type: 'string' }, description: 'Ids des lignes.' } },
        required: ['base', 'rows'], additionalProperties: false,
      },
    },
    async run(args, ctx) {
      const refs = [...new Set(list(args.rows, 'les ids des lignes (rows)', MAX_ROWS).map(x => (typeof x === 'string' ? x.trim() : '')))]
      if (refs.some(r => !r)) throw new Error('rows attend des ids de lignes (textes).')
      requireDirect(ctx, 'ne supprime pas de ligne')
      return withBase(api, args.base, async b => {
        const found = await findRows(api, b, refs)
        const pages = found.filter(r => r.kind === 'page')
        if (pages.length > MAX_PAGE_ROWS) throw new Error(`Trop de lignes-pages à supprimer (${pages.length}) : ${MAX_PAGE_ROWS} au plus par appel.`)
        if (pages.length && typeof api.vault.deleteFile !== 'function') throw new Error('Ce vault ne permet pas de mettre une note à la corbeille.')
        for (const r of found) {
          if (r.kind === 'light') await b.rows.remove(r.id)
          else await api.vault.deleteFile!(r.id)
        }
        return {
          text: `${found.length} ligne(s) supprimée(s) de ${b.path}${pages.length ? ` (${pages.length} note(s) à la corbeille)` : ''}.`,
          sources: sourcesOf(b),
        }
      })
    },
  }

  // L'ordre des deux premiers est connu d'autres modules : ne pas le changer.
  return [describe, setCell, listBases, query, create, updateSchema, addRows, updateRows, deleteRows]
}

/** Les lignes qui portent une propriete (pour la renommer), lues page par page. */
async function rowsWith(api: PluginAPI, b: OpenedBase, key: string): Promise<QueryRow[]> {
  const engine = requireQuery(api)
  const rows: QueryRow[] = []
  let cursor: string | undefined
  do {
    const r = await engine.query({ from: b.source(), where: { field: { prop: key }, op: 'notEmpty' }, select: [key], limit: 500, ...(cursor ? { cursor } : {}) })
    rows.push(...r.rows)
    cursor = r.next
  } while (cursor && rows.length < MAX_RENAME_ROWS)
  if (cursor) throw new Error(`Trop de lignes à réécrire pour renommer ${key} : à faire dans Savoire.`)
  return rows
}

/** Renomme une propriete : lignes, type du vault, colonne, vues et filtre de la source (comme la vue). */
async function renameProperty(api: PluginAPI, b: OpenedBase, col: Column, to: string, rows: readonly QueryRow[]): Promise<void> {
  const from = col.key
  for (const r of rows) {
    if (r.path === '') await b.rows.renameKey(r.id, from, to)
    else await renameNoteProperty(api.vault, r.id, from, to)
  }
  const def = api.properties?.get(from)
  if (def && !api.properties?.get(to)) api.properties?.set({ ...def, key: to })
  b.store.setColumn(to, { width: col.width, order: col.order })
  b.store.removeColumn(from)
  const swap = (k: string): string => (k === from ? to : k)
  const m = b.manifest()
  for (const v of m.views) {
    const uses = v.groupBy === from || v.hidden.includes(from) || from in v.totals || v.sorts.some(x => x.key === from) || JSON.stringify(v.filters).includes(JSON.stringify(from))
    if (!uses) continue
    b.store.setView(v.id, {
      filters: mapFilterKeys(v.filters, swap),
      sorts: v.sorts.map(x => ({ ...x, key: swap(x.key) })),
      hidden: v.hidden.map(swap),
      totals: Object.fromEntries(Object.entries(v.totals).map(([k, t]) => [swap(k), t])),
      groupBy: swap(v.groupBy),
    })
  }
  if (m.source.filters.length) b.store.setSource({ filters: mapFilterKeys(m.source.filters, swap) })
}

/** L'id d'un document tout juste cree (l'arborescence suit un peu apres dans l'appli). */
async function idAfterCreate(api: PluginAPI, path: string, timeoutMs = 5000): Promise<string> {
  const until = Date.now() + timeoutMs
  for (;;) {
    const id = api.vault.resolveDocumentId(path) ?? (api.vault.getFileTree?.() ?? []).find(f => f.path === path)?.docId
    if (id) return id
    if (Date.now() > until) throw new Error(`Base introuvable après sa création : ${path}.`)
    await new Promise(res => setTimeout(res, 50))
  }
}
