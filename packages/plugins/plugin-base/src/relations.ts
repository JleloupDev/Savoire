// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Relations entre bases et rollups.
//
// Une relation est une propriete de type 'relation' (PropertyDef.relation :
// la base visee, et la propriete en retour si elle va dans les deux sens).
// Sa valeur est une liste de liens [[Dossier/Note]] vers des lignes-pages de
// la base visee : lisible par Obsidian, suivie par les retroliens. Une ligne
// legere n'a pas de note : elle peut pointer vers des pages, pas etre visee.
//
// Un rollup est une colonne calculee ('=Nom', manifest.columns[...].rollup) :
// une propriete des lignes liees par une relation, affichee telle quelle ou
// resumee (somme, moyenne, nombre...). Le calcul se fait dans le client, sur
// les lignes de la base visee (BASE_QUERY_MAX_ROWS au plus), relues quand
// elle change.
import { parseFrontmatter, removeFrontmatterKey, setFrontmatterValue } from '@savoire/plugin-api'
import type {
  CompiledFormula, FormulaResult, FormulaRow, IQueryEngine, PluginAPI, PropertyValue, QueryRow, QuerySource,
} from '@savoire/plugin-api'
import { linkTarget } from './cells'
import { readManifest } from './manifest'
import { folderOfBase, type NotesVault } from './notes'
import { fetchBaseRows } from './queryBlock'
import { toWhere } from './filters'
import { rollupValue, type RollupDef } from './rollup'

export { ROLLUP_CALCS, readRollup, rollupValue } from './rollup'
export type { RollupCalc, RollupDef } from './rollup'

// ── Liens ────────────────────────────────────────────────────────────────

/** Cle de comparaison d'un lien ou d'un chemin : sans [[ ]], sans extension .md, sans casse. */
export function linkKey(v: string): string {
  const t = linkTarget(v).replace(/\\/g, '/').replace(/^\/+/, '')
  return t.replace(/\.md$/i, '').toLowerCase()
}

/** Lien vers une ligne-page : son chemin sans .md. */
export function rowLink(path: string): string {
  return `[[${path.replace(/\.md$/i, '')}]]`
}

export function asLinks(v: PropertyValue | undefined): string[] {
  if (v === null || v === undefined || v === '') return []
  return (Array.isArray(v) ? v : [v]).map(String).filter(Boolean)
}

/** Dossier d'un chemin, pour l'indice d'une ligne proposee. */
function folderOf(path: string): string {
  const i = path.lastIndexOf('/')
  return i < 0 ? '' : path.slice(0, i)
}

// ── Source d'une base visee ──────────────────────────────────────────────

/** Les lignes d'une base designee par l'id de son document : son dossier et son filtre de source. */
export async function baseSourceOf(api: PluginAPI | undefined, baseId: string, path: string | undefined): Promise<QuerySource> {
  let folder = path ? folderOfBase(path) : ''
  let where
  const tree = await api?.vault.openTree?.(baseId).catch(() => undefined)
  if (tree) {
    const manifest = readManifest(tree, folder)
    folder = manifest.source.folder
    where = toWhere(manifest.source.filters, manifest.source.filterMode, { me: api?.vault.getCurrentUser?.()?.id })
    api?.vault.closeTree?.(baseId)
  }
  return { base: baseId, pages: { folder: folder.replace(/\/+$/, '') || undefined, ext: ['md'], ...(where ? { where } : {}) } }
}

// ── Lignes des bases visees ──────────────────────────────────────────────

interface Loaded {
  byPath: Map<string, QueryRow>
  /** Par nom de note : null si deux notes portent le meme nom. */
  byName: Map<string, QueryRow | null>
  rows: QueryRow[]
}

/**
 * Lignes des bases visees par les relations d'une vue, tenues a jour : un
 * changement d'une base visee relit ses lignes et previent la vue.
 */
export class RelatedRows {
  private readonly loaded = new Map<string, Loaded>()
  private readonly stops = new Map<string, () => void>()
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>()
  private closed = false

  constructor(
    private readonly engine: IQueryEngine,
    private readonly sourceOf: (baseId: string) => Promise<QuerySource>,
    private readonly changed: (baseId: string) => void,
  ) {}

  /** Suit une base (sans effet si deja suivie). */
  follow(baseId: string): void {
    if (this.closed || !baseId || this.stops.has(baseId)) return
    this.stops.set(baseId, () => {})
    void this.sourceOf(baseId).then(source => {
      if (this.closed) return
      const stop = this.engine.watch({ from: source, limit: 1 }, () => {
        const t = this.timers.get(baseId)
        if (t) clearTimeout(t)
        this.timers.set(baseId, setTimeout(() => { this.timers.delete(baseId); void this.load(baseId, source) }, 80))
      })
      this.stops.set(baseId, stop)
    }, err => console.warn('[plugin-base] relation', err))
  }

  private async load(baseId: string, source: QuerySource): Promise<void> {
    try {
      const { rows } = await fetchBaseRows(this.engine, { from: source })
      if (this.closed) return
      const byPath = new Map<string, QueryRow>()
      const byName = new Map<string, QueryRow | null>()
      for (const r of rows) {
        if (!r.path) continue
        const key = linkKey(r.path)
        byPath.set(key, r)
        const name = key.slice(key.lastIndexOf('/') + 1)
        byName.set(name, byName.has(name) ? null : r)
      }
      this.loaded.set(baseId, { byPath, byName, rows })
      this.changed(baseId)
    } catch (err) { console.warn('[plugin-base] relation', err) }
  }

  /** Lignes connues d'une base (null : pas encore lues ; la lecture demarre). */
  rows(baseId: string): QueryRow[] | null {
    this.follow(baseId)
    return this.loaded.get(baseId)?.rows ?? null
  }

  /** La ligne visee par un lien : par chemin, sinon par nom s'il est unique. */
  find(baseId: string, link: string): QueryRow | undefined {
    this.follow(baseId)
    const l = this.loaded.get(baseId)
    if (!l) return undefined
    const key = linkKey(link)
    return l.byPath.get(key) ?? l.byName.get(key.slice(key.lastIndexOf('/') + 1)) ?? undefined
  }

  isLoaded(baseId: string): boolean {
    return this.loaded.has(baseId)
  }

  close(): void {
    this.closed = true
    for (const stop of this.stops.values()) stop()
    for (const t of this.timers.values()) clearTimeout(t)
    this.stops.clear()
    this.timers.clear()
    this.loaded.clear()
  }
}

// ── Rollups ──────────────────────────────────────────────────────────────

/** Une colonne calculee a part : le moteur ne sait pas la calculer, tout se fait dans le client. */
export interface ClientComputed extends CompiledFormula {
  readonly clientOnly: true
}

export function isClientOnly(f: CompiledFormula | undefined): boolean {
  return !!f && (f as Partial<ClientComputed>).clientOnly === true
}

/**
 * Le rollup en « formule » : meme contrat que les colonnes formules (table,
 * kanban, totaux, filtres et tris dans le client).
 */
export function rollupFormula(def: RollupDef, targetBase: () => string | undefined, related: RelatedRows): ClientComputed {
  const fail = (error: string): FormulaResult => ({ ok: false, error })
  return {
    clientOnly: true,
    source: `rollup:${JSON.stringify(def)}`,
    props: [def.relation],
    aggregates: false,
    aggregateCalls: null,
    evaluateAggregates: () => fail('Un rollup ne s’agrège pas.'),
    toFilter: () => null,
    evaluate(row: FormulaRow): FormulaResult {
      const base = targetBase()
      if (!base) return fail(`« ${def.relation} » n’est pas une relation vers une base.`)
      const links = asLinks(row.values[def.relation])
      if (!links.length) return { ok: true, value: def.calc === 'count' ? 0 : null }
      if (!related.isLoaded(base)) { related.follow(base); return { ok: true, value: null } }
      const rows = links.map(l => related.find(base, l)).filter((r): r is QueryRow => !!r)
      const values = rows.map(r => def.prop === '@title' ? r.title : r.values[def.prop])
      return { ok: true, value: rollupValue(def.calc, values, rows.length) }
    },
  }
}

// ── Relation dans les deux sens ──────────────────────────────────────────

/**
 * Apres une modification d'une relation a double sens, les lignes ajoutees
 * pointent vers `selfLink` dans leur propriete `back`, et les lignes retirees
 * n'y pointent plus. Une ecriture par note, comme une frappe.
 */
export async function syncBackLinks(
  vault: NotesVault,
  resolve: (link: string) => string | undefined,
  selfLink: string,
  selfId: string,
  back: string,
  before: string[],
  after: string[],
): Promise<void> {
  const editText = vault.editText
  if (!editText) return
  const keyOf = (l: string) => linkKey(l)
  const was = new Set(before.map(keyOf))
  const now = new Set(after.map(keyOf))
  const self = keyOf(selfLink)
  const jobs: { link: string; add: boolean }[] = [
    ...after.filter(l => !was.has(keyOf(l))).map(link => ({ link, add: true })),
    ...before.filter(l => !now.has(keyOf(l))).map(link => ({ link, add: false })),
  ]
  for (const job of jobs) {
    const id = resolve(job.link)
    if (!id || id === selfId) continue
    await editText(id, md => {
      const current = asLinks(parseFrontmatter(md)[back] as PropertyValue | undefined)
      const has = current.some(l => keyOf(l) === self)
      if (job.add === has) return md
      const next = job.add ? [...current, selfLink] : current.filter(l => keyOf(l) !== self)
      return next.length ? setFrontmatterValue(md, back, next) : removeFrontmatterKey(md, back)
    })
  }
}

/** Lignes proposees dans le menu d'une relation : les pages de la base visee, filtrees sur leur nom. */
export function relationChoicesOf(rows: QueryRow[], text: string, limit = 50): { link: string; title: string; hint?: string }[] {
  const fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
  const t = fold(text.trim())
  return rows
    .filter(r => r.path && (!t || fold(r.title).includes(t)))
    .sort((a, b) => a.title.localeCompare(b.title))
    .slice(0, limit)
    .map(r => ({ link: rowLink(r.path), title: r.title || r.path, hint: folderOf(r.path) || undefined }))
}
