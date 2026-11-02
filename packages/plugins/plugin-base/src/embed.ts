// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Base integree dans une note, en lecture seule :
//
//   ![[db.base]]           la premiere vue
//   ![[db.base#Kanban]]    la vue nommee « Kanban »
//
// Memes colonnes, filtres, tris et formules que la vue de la base, suivis en
// direct. On ne modifie rien ici : un clic sur le nom ouvre la base.
import { BLOCK_DESTROY_EVENT, guessPropertyType, tryCompileFormula } from '@savoire/plugin-api'
import type { ISharedTree, PluginAPI, PropertyType, Query, QueryResult, QueryRow } from '@savoire/plugin-api'
import { h, renderValue, valueText, type CellContext } from './cells'
import { TITLE_COLUMN, isFormulaKey, FORMULA_PREFIX, readManifest, type BaseManifest, type BaseViewDef } from './manifest'
import { folderOfBase } from './notes'
import { resolveBase } from './queryBlock'
import { toSort, toWhere } from './view'

export const BASE_EMBED_RE = /^\s*!\[\[([^\]|#]+\.base)(?:#([^\]|]+))?(?:\|[^\]]*)?\]\]\s*$/i

/** Lignes montrees au plus ; la suite s'ouvre dans la base. */
export const EMBED_ROWS = 100

export interface BaseEmbedTarget { path: string; view?: string }

export function parseBaseEmbed(text: string): BaseEmbedTarget | null {
  const m = BASE_EMBED_RE.exec(text)
  return m ? { path: m[1].trim(), view: m[2]?.trim() || undefined } : null
}

/** La requete d'une vue, comme dans la base elle-meme. */
export function embedQuery(baseId: string, manifest: BaseManifest, view: BaseViewDef): Query {
  const folder = manifest.source.folder.replace(/\/+$/, '') || undefined
  return {
    from: { base: baseId, pages: { folder, ext: ['md'], where: toWhere(manifest.source.filters) } },
    where: toWhere(view.filters),
    sort: toSort(view.sorts),
  }
}

export function renderBaseEmbed(target: BaseEmbedTarget, api: PluginAPI | undefined): HTMLElement {
  const el = h('div', { class: 'base-q base-embed', 'data-testid': 'base-embed' }, h('div', { class: 'base-q-message' }, '…'))
  const fail = (msg: string) => el.replaceChildren(h('div', { class: 'base-q-message base-q-bad', 'data-testid': 'base-embed-error' }, `⚠ ${msg}`))
  const engine = api?.query
  if (!api || !engine) { fail('Aucun moteur de requêtes : ouvrez un vault.'); return el }

  let tree: ISharedTree | undefined
  let baseId = ''
  let stops: (() => void)[] = []
  let dead = false
  const cleanup = () => {
    for (const s of stops) s()
    stops = []
    if (tree && baseId) api.vault.closeTree?.(baseId)
    tree = undefined
  }
  // Retire par l'editeur : on cesse de suivre. Un onglet masque ne compte pas.
  el.addEventListener(BLOCK_DESTROY_EVENT, () => { dead = true; cleanup() }, { once: true })
  const alive = (): boolean => !dead

  void resolveBase(api, target.path).then(async base => {
    if (!base) { fail(`Base introuvable : « ${target.path} »`); return }
    baseId = base.id
    tree = await api.vault.openTree?.(base.id).catch(() => undefined)
    if (dead) { cleanup(); return }
    let watchStop: (() => void) | null = null
    let lastQuery = ''
    const types = api.properties
    const ctx: CellContext = {
      members: [],
      knownValues: async () => [],
      openLink: t => void api.workspace.openFile(t),
    }
    const refresh = () => {
      if (!alive()) return
      const manifest = readManifest(tree, folderOfBase(base.path))
      const view = (target.view
        ? manifest.views.find(v => v.name.toLowerCase() === target.view!.toLowerCase())
        : undefined) ?? manifest.views[0]
      if (target.view && view.name.toLowerCase() !== target.view.toLowerCase()) {
        fail(`Vue introuvable : « ${target.view} » (vues : ${manifest.views.map(v => v.name).join(', ')})`)
        return
      }
      current = { manifest, view }
      const query = embedQuery(base.id, manifest, view)
      const key = JSON.stringify(query)
      if (key !== lastQuery) {
        lastQuery = key
        watchStop?.()
        watchStop = engine.watch({ ...query, limit: EMBED_ROWS }, r => {
          last = r
          if (alive() && current) render(r, current.manifest, current.view)
        })
      } else if (last) {
        // Meme requete (colonnes, largeurs, formules) : on redessine seulement.
        render(last, manifest, view)
      }
    }
    let current: { manifest: BaseManifest; view: BaseViewDef } | null = null
    let last: QueryResult | null = null
    const render = (r: QueryResult, manifest: BaseManifest, view: BaseViewDef) => {
      const typeOf = (k: string): PropertyType => types?.get(k)?.type ?? guessPropertyType(r.rows.find(x => x.values[k] != null)?.values[k] ?? null)
      // Colonnes de la vue ; une base jamais enregistree montre ses proprietes les plus remplies.
      let keys = manifest.columns.map(c => c.key).filter(k => k !== TITLE_COLUMN && !view.hidden.includes(k))
      if (!manifest.stored) {
        const counts = new Map<string, number>()
        for (const row of r.rows) for (const [k, v] of Object.entries(row.values)) if (v !== null && v !== '') counts.set(k, (counts.get(k) ?? 0) + 1)
        keys = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k]) => k)
      }
      const formulas = new Map(keys.filter(isFormulaKey).map(k => [k, tryCompileFormula(manifest.columns.find(c => c.key === k)?.formula ?? '')]))
      const label = (k: string) => isFormulaKey(k) ? k.slice(FORMULA_PREFIX.length) : (types?.get(k)?.label ?? k)
      const cell = (row: QueryRow, k: string): Node => {
        const f = formulas.get(k)
        if (f) {
          if ('error' in f) return h('span', { class: 'base-q-error', title: f.error }, '⚠')
          const v = f.formula.evaluate(row)
          if (!v.ok) return h('span', { class: 'base-q-error', title: v.error }, '⚠')
          const t: PropertyType = typeof v.value === 'number' ? 'number' : typeof v.value === 'boolean' ? 'checkbox' : Array.isArray(v.value) ? 'multiselect' : 'text'
          return renderValue(t, v.value, ctx)
        }
        return renderValue(typeOf(k), row.values[k] ?? null, ctx)
      }
      const name = (row: QueryRow): Node => {
        if (!row.path) return document.createTextNode(row.title || 'Sans titre')
        const a = h('a', { href: '#' }, row.title || 'Sans titre')
        a.addEventListener('click', e => { e.preventDefault(); void api.workspace.openFile(row.path) })
        return a
      }
      const open = h('a', { class: 'base-q-source', href: '#', title: `Ouvrir ${base.path}` }, `🗃️ ${base.path.split('/').pop()} · ${view.name}`)
      open.addEventListener('click', e => { e.preventDefault(); void api.workspace.openFile(base.path) })
      const foot = h('div', { class: 'base-q-foot' }, open,
        h('span', { 'data-testid': 'base-embed-count' }, r.total > r.rows.length ? `${r.rows.length} / ${r.total} lignes` : `${r.total} ligne${r.total > 1 ? 's' : ''}`),
        h('span', {}, 'lecture seule'))

      if (view.type === 'kanban' && view.groupBy) {
        const lanes = new Map<string, QueryRow[]>()
        for (const row of r.rows) {
          const v = row.values[view.groupBy]
          const k = v === null || v === undefined || v === '' ? 'Sans valeur' : valueText(v)
          lanes.set(k, [...(lanes.get(k) ?? []), row])
        }
        const board = h('div', { class: 'base-embed-board' }, ...[...lanes.entries()].map(([k, rows]) =>
          h('div', { class: 'base-embed-lane', 'data-testid': 'base-embed-lane' },
            h('div', { class: 'base-embed-lane-head' }, `${k} · ${rows.length}`),
            ...rows.map(row => h('div', { class: 'base-embed-card' }, name(row))))))
        el.replaceChildren(board, foot)
        return
      }
      const head = h('tr', {}, h('th', {}, 'Nom'), ...keys.map(k => h('th', {}, label(k))))
      const body = r.rows.map(row => h('tr', { 'data-testid': 'base-embed-row' },
        h('td', {}, name(row)), ...keys.map(k => h('td', {}, cell(row, k)))))
      el.replaceChildren(h('table', { class: 'base-q-table' }, h('thead', {}, head), h('tbody', {}, ...body)), foot)
    }
    stops.push(() => watchStop?.())
    // Manifeste modifie (colonnes, filtres, vue) : on relit la vue.
    if (tree) stops.push(tree.onChange(() => refresh()))
    refresh()
  }).catch(err => fail((err as { message?: string })?.message ?? String(err)))
  return el
}
