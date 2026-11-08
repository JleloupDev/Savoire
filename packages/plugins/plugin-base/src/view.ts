// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// La vue d'un fichier .base : barre des vues (onglets), reglages de la vue
// (filtres, tris, regroupement, colonnes, source), puis le tableau ou le
// kanban. Les lignes viennent d'api.query (lignes-pages du dossier de la
// base + lignes legeres de ses lots), le manifeste du document (ctx.tree).
import {
  createIcon,
  BASE_ROW_TITLE, PROPERTY_TYPES, PROPERTY_TYPE_INFO, guessPropertyType, tryCompileFormula,
} from '@savoire/plugin-api'
import type {
  CompiledFormula,
  FileContext, FileView, FilterOp, IndexState, PluginAPI, PropertyMember, PropertyType, PropertyValue,
  Query, QueryFilter, QueryResult, QueryRow, QuerySort, QuerySource,
} from '@savoire/plugin-api'
import { h, valueText, type CellContext } from './cells'
import {
  DEFAULT_WIDTH, FORMULA_PREFIX, ManifestStore, TITLE_COLUMN, TITLE_WIDTH, defaultView, isFormulaKey, readManifest,
  type BaseFilter, type BaseManifest, type BaseSort, type BaseViewDef,
} from './manifest'
import { LightRows } from './rows'
import { createPageRow, folderOfBase, renamePageRow, writeNoteProperty, type NotesVault } from './notes'
import { BaseTable, type TableColumn } from './table'
import { BaseKanban } from './kanban'
import { needsFormulas, withFormulas } from './formulaEngine'
import { fetchBaseRows } from './queryBlock'
import { TOTAL_KINDS, computeTotal, totalText, type TotalKind } from './totals'
import { ensureStyle } from './style'

const OPS: { op: FilterOp; label: string; needsValue: boolean }[] = [
  { op: 'eq', label: 'est', needsValue: true },
  { op: 'neq', label: "n'est pas", needsValue: true },
  { op: 'contains', label: 'contient', needsValue: true },
  { op: 'startsWith', label: 'commence par', needsValue: true },
  { op: 'lt', label: '<', needsValue: true },
  { op: 'lte', label: '≤', needsValue: true },
  { op: 'gt', label: '>', needsValue: true },
  { op: 'gte', label: '≥', needsValue: true },
  { op: 'empty', label: 'est vide', needsValue: false },
  { op: 'notEmpty', label: "n'est pas vide", needsValue: false },
]

/** Vue active d'une base, pour les commandes (la derniere qui a eu le focus). */
export let activeBaseView: BaseViewHandle | null = null

export interface BaseViewHandle {
  addPage(values?: Record<string, PropertyValue>): Promise<void>
  addLightRow(values?: Record<string, PropertyValue>): Promise<void>
}

function fieldOf(key: string): { prop: string } | { doc: 'title' } {
  return key === TITLE_COLUMN ? { doc: 'title' } : { prop: key }
}

export function toWhere(filters: BaseFilter[]): QueryFilter | undefined {
  const parts: QueryFilter[] = filters.filter(f => f.key).map(f => ({ field: fieldOf(f.key), op: f.op, value: f.value ?? undefined }))
  if (parts.length === 0) return undefined
  return parts.length === 1 ? parts[0] : { and: parts }
}

export function toSort(sorts: BaseSort[]): QuerySort[] {
  const s = sorts.filter(x => x.key).map(x => ({ field: fieldOf(x.key), dir: x.dir }))
  return s.length ? s : [{ field: { doc: 'title' } }]
}

function stateText(s: IndexState): string {
  switch (s.status) {
    case 'building': return `Index en construction${s.progress !== undefined ? `, ${Math.round(s.progress * 100)} %` : ''}`
    case 'lagging': return `Index en retard${s.lagMs ? ` (${Math.round(s.lagMs / 1000)} s)` : ''}`
    case 'unavailable': return 'Index indisponible : mode dégradé'
    default: return ''
  }
}

export function createBaseView(path: string, ctx: FileContext, api: PluginAPI | undefined): FileView & BaseViewHandle {
  ensureStyle()
  // Le vault du document (chemins, creation, renommage) ; l'edition d'une
  // note hors de son editeur vient de l'API des plugins (VaultAPI.editText).
  const docVault = ctx.vault ?? api?.vault
  const editText = ctx.vault?.editText ?? api?.vault?.editText
  const vault: NotesVault | undefined = docVault && {
    resolveDocumentId: p => docVault.resolveDocumentId(p),
    createFile: docVault.createFile && (p => docVault.createFile!(p)),
    renameFile: docVault.renameFile && ((id, p) => docVault.renameFile!(id, p)),
    editText: editText && ((id, fn) => editText(id, fn)),
  }
  const engine = api?.query
  const types = api?.properties
  const baseId = vault?.resolveDocumentId(path)
  const defaultFolder = folderOfBase(path)
  let readOnly = !!ctx.readOnly
  let manifest: BaseManifest = readManifest(ctx.tree, defaultFolder)
  let activeId = manifest.views[0].id
  /** Proprietes vues dans les lignes, par frequence : colonnes par defaut, choix proposes. */
  const seen = new Map<string, { count: number; sample: PropertyValue }>()
  let members: PropertyMember[] = []
  let container: HTMLElement | null = null
  const unsubs: (() => void)[] = []

  const columnsOf = (m: BaseManifest) => m.stored
    ? m.columns
    : [...seen.entries()].sort((a, b) => b[1].count - a[1].count).slice(0, 8).map(([key], i) => ({ key, width: DEFAULT_WIDTH, order: i + 1 }))

  const store = new ManifestStore(ctx.tree, () => ({ ...manifest, columns: columnsOf(manifest), views: manifest.views }))
  const lightRows = new LightRows(ctx.shared, store, () => manifest.lotCount)

  const view = (): BaseViewDef => manifest.views.find(v => v.id === activeId) ?? manifest.views[0] ?? defaultView()
  const typeOf = (key: string): PropertyType => types?.get(key)?.type ?? guessPropertyType(seen.get(key)?.sample ?? null)
  const label = (key: string) => key === TITLE_COLUMN ? 'Nom' : isFormulaKey(key) ? key.slice(FORMULA_PREFIX.length) : (types?.get(key)?.label ?? key)

  // Formules compilees, par texte : recompilees seulement quand elles changent.
  let compiled = new Map<string, { formula: CompiledFormula } | { error: string }>()
  const compile = (source: string) => {
    let c = compiled.get(source)
    if (!c) {
      c = tryCompileFormula(source)
      if (compiled.size > 200) compiled = new Map()
      compiled.set(source, c)
    }
    return c
  }
  const formulaOf = (key: string): string | undefined => manifest.columns.find(c => c.key === key)?.formula
  /** Le moteur, plus les filtres et tris sur formules (calcules ici, voir formulaEngine). */
  const rowsEngine = engine && withFormulas(engine, key => {
    const f = compile(formulaOf(key) ?? '')
    return 'formula' in f ? f.formula : undefined
  })
  /** Empreinte des formules : une formule modifiee relance une requete qui filtre ou trie dessus. */
  const formulaSig = () => JSON.stringify(manifest.columns.filter(c => isFormulaKey(c.key)).map(c => [c.key, c.formula]))
  let lastFormulaSig = ''

  const allColumns = (): TableColumn[] => {
    const title: TableColumn = { key: TITLE_COLUMN, label: 'Nom', width: manifest.columns.find(c => c.key === TITLE_COLUMN)?.width ?? TITLE_WIDTH, type: 'text' }
    return [title, ...columnsOf(manifest).filter(c => c.key !== TITLE_COLUMN).map((c): TableColumn => {
      if (!isFormulaKey(c.key)) return { key: c.key, label: label(c.key), width: c.width, type: typeOf(c.key) }
      const f = compile(formulaOf(c.key) ?? '')
      return { key: c.key, label: label(c.key), width: c.width, type: 'text', ...('formula' in f ? { formula: f.formula } : { formulaError: f.error }) }
    })]
  }
  const visibleColumns = (): TableColumn[] => allColumns().filter(c => c.key === TITLE_COLUMN || !view().hidden.includes(c.key))

  const source = (): QuerySource => {
    const where = toWhere(manifest.source.filters)
    const folder = manifest.source.folder.replace(/\/+$/, '') || undefined
    if (baseId) return { base: baseId, pages: { folder, ext: ['md'], where } }
    return { notes: true, folder, ext: ['md'] }
  }
  const query = (): Query => {
    const v = view()
    const where = toWhere(v.filters)
    const from = source()
    // Sans id de base, le filtre de source rejoint celui de la vue.
    const sourceWhere = 'notes' in from ? toWhere(manifest.source.filters) : undefined
    const all = [sourceWhere, where].filter((x): x is QueryFilter => !!x)
    return { from, where: all.length === 0 ? undefined : all.length === 1 ? all[0] : { and: all }, sort: toSort(v.sorts) }
  }

  const knownValues = async (key: string): Promise<string[]> => {
    const options = types?.get(key)?.options?.map(o => o.value) ?? []
    if (!engine) return options
    try {
      const r = await engine.query({ from: source(), groupBy: { prop: key }, limit: 1 })
      return [...new Set([...options, ...(r.groups ?? []).map(g => g.key).filter((k): k is string => typeof k === 'string')])]
    } catch { return options }
  }
  const cells = (): CellContext => ({
    members,
    knownValues,
    openLink: target => void api?.workspace.openFile(target),
  })

  // ── Ecritures ────────────────────────────────────────────────────────────

  const report = (err: unknown) => {
    console.error('[plugin-base]', err)
    const status = container?.querySelector('[data-testid="base-error"]')
    if (status) status.textContent = err instanceof Error ? err.message : String(err)
  }

  /** Une cellule : frontmatter de la note, ou carte de la ligne dans son lot. */
  const edit = (row: QueryRow, key: string, value: PropertyValue) => {
    // Une formule ne s'ecrit pas (carte deplacee dans un kanban groupe par formule).
    if (readOnly || isFormulaKey(key)) return
    const job = row.path === ''
      ? lightRows.setCell(row.id, key, value)
      : vault ? writeNoteProperty(vault, row.id, key, value) : Promise.reject(new Error('Aucun vault.'))
    void job.catch(report)
  }

  const rename = (row: QueryRow, title: string) => {
    if (readOnly || title === row.title) return
    const job = row.path === ''
      ? lightRows.setCell(row.id, BASE_ROW_TITLE, title)
      : vault ? renamePageRow(vault, row.id, row.path, title) : Promise.reject(new Error('Aucun vault.'))
    void job.catch(report)
  }

  const addPage = async (values: Record<string, PropertyValue> = {}) => {
    if (readOnly || !vault) return
    try {
      const own = Object.fromEntries(Object.entries(values).filter(([k]) => !isFormulaKey(k)))
      await createPageRow(vault, manifest.source.folder, 'Sans titre', own)
    } catch (err) { report(err) }
  }

  const addLightRow = async (values: Record<string, PropertyValue> = {}) => {
    if (readOnly) return
    try {
      await lightRows.add('Sans titre', values)
    } catch (err) { report(err) }
  }

  /** Une ligne legere devient une note, ses valeurs en frontmatter. */
  const promote = async (row: QueryRow) => {
    if (readOnly || !vault) return
    try {
      const full = await lightRows.get(row.id)
      if (!full) throw new Error('Cette ligne n\'existe plus.')
      await createPageRow(vault, manifest.source.folder, full.title || 'Sans titre', full.values)
      await lightRows.remove(row.id)
    } catch (err) { report(err) }
  }

  // ── Rendu ────────────────────────────────────────────────────────────────

  const table = rowsEngine ? new BaseTable({
    engine: rowsEngine,
    readOnly: () => readOnly,
    columns: visibleColumns,
    cells,
    edit,
    rename,
    open: row => void api?.workspace.openFile(row.path),
    promote: row => void promote(row),
    remove: row => void lightRows.remove(row.id).catch(report),
    columnMenu: (key, anchor) => openColumnMenu(key, anchor),
    resize: (key, width) => store.setColumn(key, { width }),
    addColumn: anchor => openAddColumn(anchor),
    onResult: r => onResult(r),
    totals: () => totalTexts,
    totalMenu: (key, anchor) => openTotalMenu(key, anchor),
    addRow: () => void addPage(),
  }) : null

  // ── Totaux des colonnes ──────────────────────────────────────────────────
  // Calcules sur toutes les lignes de la vue (BASE_QUERY_MAX_ROWS au plus),
  // relus a chaque changement de l'index.

  let totalTexts = new Map<string, string>()
  let totalsKey = ''
  let totalsStop: (() => void) | null = null
  let totalsTimer: ReturnType<typeof setTimeout> | null = null
  const stopTotals = () => {
    totalsStop?.(); totalsStop = null
    if (totalsTimer) { clearTimeout(totalsTimer); totalsTimer = null }
  }
  const cellValue = (row: QueryRow, key: string): PropertyValue | undefined => {
    if (key === TITLE_COLUMN) return row.title
    if (!isFormulaKey(key)) return row.values[key]
    const f = compile(formulaOf(key) ?? '')
    if (!('formula' in f)) return undefined
    const r = f.formula.evaluate(row)
    return r.ok ? r.value : undefined
  }
  const syncTotals = (q: Query, v: BaseViewDef) => {
    const wanted = Object.entries(v.totals).filter(([k]) => allColumns().some(c => c.key === k))
    if (!rowsEngine || v.type !== 'table' || wanted.length === 0) {
      stopTotals()
      totalsKey = ''
      if (totalTexts.size) { totalTexts = new Map(); table?.renderFoot() }
      return
    }
    const key = JSON.stringify([q, wanted, formulaSig()])
    if (key === totalsKey) return
    totalsKey = key
    stopTotals()
    // Calcul sur les lignes lues ; les anciens totaux restent affiches pendant ce temps.
    const run = async () => {
      try {
        const { rows, truncated } = await fetchBaseRows(rowsEngine, q)
        if (totalsKey !== key) return
        const next = new Map<string, string>()
        for (const [k, kind] of wanted) {
          const text = totalText(kind, computeTotal(kind, rows.map(r => cellValue(r, k))))
          next.set(k, truncated ? `≈ ${text}` : text)
        }
        totalTexts = next
        table?.renderFoot()
      } catch (err) { console.warn('[plugin-base] totaux', err) }
    }
    const followRows = () => {
      totalsStop = rowsEngine.watch({ ...q, limit: 1 }, () => {
        if (totalsTimer) clearTimeout(totalsTimer)
        totalsTimer = setTimeout(() => { totalsTimer = null; void run() }, 150)
      })
    }
    // Le moteur sait calculer : un seul aller, sans lire les lignes.
    const engineOps: Partial<Record<TotalKind, 'sum' | 'mean' | 'min' | 'max' | 'count'>> = { sum: 'sum', mean: 'mean', min: 'min', max: 'max', filled: 'count', empty: 'count' }
    const viaEngine = !needsFormulas(q) && wanted.every(([k, kind]) => !isFormulaKey(k) && engineOps[kind])
    if (!viaEngine) { followRows(); return }
    const aggregate = wanted.map(([k, kind]) => ({ op: engineOps[kind]!, field: k === TITLE_COLUMN ? { doc: 'title' as const } : { prop: k } }))
    let fallback = false
    totalsStop = rowsEngine.watch({ ...q, aggregate, limit: 1 }, r => {
      if (totalsKey !== key || fallback) return
      if (!r.aggregates || r.aggregates.length !== wanted.length) {
        // Moteur sans agregats : calcul sur les lignes (apres ce rappel, qui
        // peut arriver avant que watch ait rendu sa fonction d'arret).
        fallback = true
        queueMicrotask(() => { if (totalsKey !== key) return; stopTotals(); followRows() })
        return
      }
      const next = new Map<string, string>()
      wanted.forEach(([k, kind], i) => {
        const v = r.aggregates![i]
        next.set(k, totalText(kind, kind === 'empty' ? r.total - Number(v ?? 0) : v))
      })
      totalTexts = next
      table?.renderFoot()
    })
  }
  const kanban = rowsEngine ? new BaseKanban({
    engine: rowsEngine,
    readOnly: () => readOnly,
    columns: visibleColumns,
    cells,
    options: key => types?.get(key)?.options?.map(o => o.value) ?? [],
    edit,
    open: row => void api?.workspace.openFile(row.path),
    addPage: values => void addPage(values),
    valueOf: (row, key) => cellValue(row, key),
  }) : null

  const onResult = (r: QueryResult) => {
    let added = false
    for (const row of r.rows) {
      for (const [k, v] of Object.entries(row.values)) {
        const s = seen.get(k)
        if (s) { s.count++; if (s.sample === null) s.sample = v } else { seen.set(k, { count: 1, sample: v }); added = true }
      }
    }
    const count = container?.querySelector('[data-testid="base-count"]')
    if (count) count.textContent = `${r.total} ligne${r.total > 1 ? 's' : ''}`
    if (added && !manifest.stored) queueMicrotask(() => table?.refresh())
  }

  let body: HTMLElement
  let toolbar: HTMLElement
  let popover: HTMLElement
  let stateEl: HTMLElement

  const renderToolbar = () => {
    const tabs = h('div', { class: 'base-tabs' }, ...manifest.views.map(v => {
      const tab = h('button', { class: v.id === activeId ? 'base-tab base-tab-active' : 'base-tab', type: 'button', 'data-testid': 'base-tab', 'data-id': v.id },
        `${v.type === 'kanban' ? '▤' : '▦'} ${v.name}`)
      tab.addEventListener('click', () => { activeId = v.id; update() })
      tab.addEventListener('dblclick', () => {
        if (readOnly || !store.writable) return
        const input = h('input', { class: 'base-tab-input', value: v.name })
        input.value = v.name
        const done = () => { const name = input.value.trim(); if (name && name !== v.name) store.setView(v.id, { name }); else update() }
        input.addEventListener('keydown', e => { if (e.key === 'Enter') input.blur(); if (e.key === 'Escape') { input.value = v.name; input.blur() } })
        input.addEventListener('blur', done)
        tab.replaceWith(input)
        input.focus()
      })
      return tab
    }))
    if (!readOnly && store.writable) {
      const add = h('button', { class: 'base-tab base-tab-add', type: 'button', title: 'Nouvelle vue', 'data-testid': 'base-add-view' }, '+')
      add.addEventListener('click', () => {
        const id = `v${Date.now().toString(36)}`
        const order = Math.max(0, ...manifest.views.map(v => v.order)) + 1
        store.setView(id, { ...defaultView(id, `Vue ${manifest.views.length + 1}`, 'table', order) })
        activeId = id
      })
      tabs.append(add)
    }
    const v = view()
    const btn = (text: string, testid: string, onClick: (b: HTMLElement) => void, active = false) => {
      const b = h('button', { class: active ? 'base-btn base-btn-on' : 'base-btn', type: 'button', 'data-testid': testid }, text)
      b.addEventListener('click', () => onClick(b))
      b.toggleAttribute('disabled', readOnly && testid.startsWith('base-new'))
      return b
    }
    const editable = !readOnly && store.writable
    const actions = h('div', { class: 'base-actions' },
      editable ? btn('▦ Tableau', 'base-type-table', () => store.setView(v.id, { type: 'table' }), v.type === 'table') : null,
      editable ? btn('▤ Kanban', 'base-type-kanban', () => {
        // Par defaut : la premiere propriete de choix, sinon le premier texte.
        const cols = allColumns().filter(c => c.key !== TITLE_COLUMN)
        const group = v.groupBy || cols.find(c => c.type === 'select')?.key || cols.find(c => c.type === 'text')?.key || ''
        store.setView(v.id, { type: 'kanban', groupBy: group })
      }, v.type === 'kanban') : null,
      btn(`Filtrer${v.filters.length ? ` (${v.filters.length})` : ''}`, 'base-filter', b => togglePopover('filters', b), v.filters.length > 0),
      btn(`Trier${v.sorts.length ? ` (${v.sorts.length})` : ''}`, 'base-sort', b => togglePopover('sorts', b), v.sorts.length > 0),
      v.type === 'kanban' ? btn(`Grouper : ${v.groupBy ? label(v.groupBy) : '—'}`, 'base-group', b => togglePopover('group', b)) : null,
      btn('Colonnes', 'base-columns', b => togglePopover('columns', b)),
      btn('Source', 'base-source', b => togglePopover('source', b)),
      h('span', { class: 'base-spacer' }),
      stateEl = h('span', { class: 'base-state', 'data-testid': 'base-index-state' }),
      btn('+ Page', 'base-new-page', () => void addPage()),
      lightRows.available ? btn('+ Ligne', 'base-new-row', () => void addLightRow()) : null,
    )
    toolbar.replaceChildren(tabs, actions)
    if (engine) stateEl.textContent = stateText(engine.state())
  }

  // ── Fenetres de reglage ──────────────────────────────────────────────────

  let popoverKind: string | null = null
  const closePopover = () => { popoverKind = null; popover.hidden = true; popover.replaceChildren(); popover.style.top = ''; popover.style.bottom = '' }
  const togglePopover = (kind: string, anchor: HTMLElement) => {
    if (popoverKind === kind) { closePopover(); return }
    popoverKind = kind
    renderPopover()
    popover.hidden = false
    popover.style.left = `${anchor.offsetLeft}px`
  }

  const propertyChoices = (withTitle: boolean): string[] => {
    const keys = new Set<string>([...allColumns().map(c => c.key), ...seen.keys(), ...(types?.schema().properties.map(p => p.key) ?? [])])
    // Filtre, tri et groupe sur une formule : le moteur la calcule.
    if (!withTitle) keys.delete(TITLE_COLUMN)
    else keys.add(TITLE_COLUMN)
    return [...keys]
  }

  const propertySelect = (value: string, withTitle: boolean, onChange: (v: string) => void) => {
    const select = h('select', { class: 'base-input' })
    select.append(h('option', { value: '' }, '—'), ...propertyChoices(withTitle).map(k => h('option', { value: k }, label(k))))
    select.value = value
    select.disabled = readOnly || !store.writable
    select.addEventListener('change', () => onChange(select.value))
    return select
  }

  const filterEditor = (filters: BaseFilter[], save: (f: BaseFilter[]) => void, testid: string) => {
    const box = h('div', { class: 'base-pop-list', 'data-testid': testid })
    filters.forEach((f, i) => {
      const set = (patch: Partial<BaseFilter>) => save(filters.map((x, j) => j === i ? { ...x, ...patch } : x))
      const op = h('select', { class: 'base-input' }, ...OPS.map(o => h('option', { value: o.op }, o.label)))
      op.value = f.op
      op.addEventListener('change', () => set({ op: op.value as FilterOp }))
      const needs = OPS.find(o => o.op === f.op)?.needsValue ?? true
      const value = h('input', { class: 'base-input', placeholder: 'valeur', 'data-testid': 'base-filter-value' })
      value.value = valueText(f.value)
      value.hidden = !needs
      value.addEventListener('change', () => {
        const t = typeOf(f.key)
        const raw = value.value
        const v: PropertyValue = t === 'number' && raw.trim() !== '' && Number.isFinite(Number(raw)) ? Number(raw)
          : t === 'checkbox' ? /^(oui|true|1|x)$/i.test(raw.trim()) : raw
        set({ value: v })
      })
      const remove = h('button', { class: 'base-btn', type: 'button', title: 'Retirer' }, '×')
      remove.addEventListener('click', () => save(filters.filter((_, j) => j !== i)))
      box.append(h('div', { class: 'base-pop-row' }, propertySelect(f.key, true, key => set({ key })), op, value, remove))
    })
    const add = h('button', { class: 'base-btn', type: 'button', 'data-testid': `${testid}-add` }, '+ Ajouter un filtre')
    add.addEventListener('click', () => save([...filters, { key: TITLE_COLUMN, op: 'contains', value: '' }]))
    box.append(add)
    return box
  }

  const renderPopover = () => {
    const v = view()
    const editable = !readOnly && store.writable
    let content: HTMLElement
    switch (popoverKind) {
      case 'filters':
        content = filterEditor(v.filters, filters => store.setView(v.id, { filters }), 'base-filters')
        break
      case 'sorts': {
        content = h('div', { class: 'base-pop-list', 'data-testid': 'base-sorts' })
        v.sorts.forEach((s, i) => {
          const set = (patch: Partial<BaseSort>) => store.setView(v.id, { sorts: v.sorts.map((x, j) => j === i ? { ...x, ...patch } : x) })
          const dir = h('select', { class: 'base-input' }, h('option', { value: 'asc' }, 'croissant'), h('option', { value: 'desc' }, 'décroissant'))
          dir.value = s.dir
          dir.addEventListener('change', () => set({ dir: dir.value as 'asc' | 'desc' }))
          const remove = h('button', { class: 'base-btn', type: 'button' }, '×')
          remove.addEventListener('click', () => store.setView(v.id, { sorts: v.sorts.filter((_, j) => j !== i) }))
          content.append(h('div', { class: 'base-pop-row' }, propertySelect(s.key, true, key => set({ key })), dir, remove))
        })
        const add = h('button', { class: 'base-btn', type: 'button', 'data-testid': 'base-sorts-add' }, '+ Ajouter un tri')
        add.addEventListener('click', () => store.setView(v.id, { sorts: [...v.sorts, { key: TITLE_COLUMN, dir: 'asc' }] }))
        content.append(add)
        break
      }
      case 'group':
        content = h('div', { class: 'base-pop-list' }, h('div', { class: 'base-pop-row' }, 'Grouper par',
          propertySelect(v.groupBy, false, groupBy => store.setView(v.id, { groupBy }))))
        break
      case 'columns': {
        content = h('div', { class: 'base-pop-list', 'data-testid': 'base-columns-list' })
        const cols = allColumns().filter(c => c.key !== TITLE_COLUMN)
        cols.forEach((c, i) => {
          const visible = h('input', { type: 'checkbox' })
          visible.checked = !v.hidden.includes(c.key)
          visible.disabled = !editable
          visible.addEventListener('change', () => store.setView(v.id, { hidden: visible.checked ? v.hidden.filter(k => k !== c.key) : [...v.hidden, c.key] }))
          const move = (delta: number) => {
            const other = cols[i + delta]
            if (!other) return
            const order = (k: string) => columnsOf(manifest).find(x => x.key === k)?.order ?? 0
            const a = order(c.key), b = order(other.key)
            store.setColumn(c.key, { order: b })
            store.setColumn(other.key, { order: a === b ? b + delta : a })
          }
          const up = h('button', { class: 'base-btn', type: 'button', title: 'Monter' }, '↑')
          up.addEventListener('click', () => move(-1))
          const down = h('button', { class: 'base-btn', type: 'button', title: 'Descendre' }, '↓')
          down.addEventListener('click', () => move(1))
          const remove = h('button', { class: 'base-btn', type: 'button', title: 'Retirer de la base' }, '×')
          remove.addEventListener('click', () => store.removeColumn(c.key))
          for (const b of [up, down, remove]) (b as HTMLButtonElement).disabled = !editable
          content.append(h('div', { class: 'base-pop-row' }, visible, h('span', { class: 'base-pop-icon' }, isFormulaKey(c.key) ? 'ƒ' : createIcon(api?.icons, PROPERTY_TYPE_INFO[c.type].icon, { size: 14 })), h('span', { class: 'base-pop-label' }, c.label), up, down, remove))
        })
        break
      }
      case 'source': {
        const folder = h('input', { class: 'base-input', 'data-testid': 'base-source-folder', placeholder: 'tout le vault' })
        folder.value = manifest.source.folder
        folder.disabled = !editable
        folder.addEventListener('change', () => store.setSource({ folder: folder.value.trim().replace(/\/+$/, '') }))
        content = h('div', { class: 'base-pop-list' },
          h('div', { class: 'base-pop-row' }, 'Dossier des pages', folder),
          h('div', { class: 'base-pop-sub' }, 'Filtre de la source'),
          filterEditor(manifest.source.filters, filters => store.setSource({ filters }), 'base-source-filters'))
        break
      }
      default:
        content = h('div')
    }
    popover.replaceChildren(content)
  }

  const openAddColumn = (anchor: HTMLElement) => {
    if (readOnly || !store.writable) return
    closePopover()
    popoverKind = 'add-column'
    const name = h('input', { class: 'base-input', placeholder: 'Propriété', 'data-testid': 'base-new-column-name', list: 'base-props-list' })
    const list = h('datalist', { id: 'base-props-list' }, ...propertyChoices(false).map(k => h('option', { value: k })))
    const type = h('select', { class: 'base-input', 'data-testid': 'base-new-column-type' },
      ...PROPERTY_TYPES.map(t => h('option', { value: t }, PROPERTY_TYPE_INFO[t].label)),
      h('option', { value: 'formula' }, 'ƒ Formule'))
    name.addEventListener('input', () => { if (type.value !== 'formula') type.value = typeOf(name.value.trim()) })
    type.addEventListener('change', () => {
      if (type.value !== 'formula') return
      const n = name.value.replace(/:/g, '').trim()
      openFormulaEditor(anchor, n ? FORMULA_PREFIX + n : undefined)
    })
    const ok = h('button', { class: 'base-btn', type: 'button', 'data-testid': 'base-new-column-ok' }, 'Ajouter')
    const confirm = () => {
      const key = name.value.replace(/:/g, '').trim()
      if (!key || key === TITLE_COLUMN || isFormulaKey(key)) return
      if (types && !types.get(key) && type.value !== typeOf(key)) {
        try { types.set({ key, type: type.value as PropertyType }) } catch { /* sans vault */ }
      }
      store.setColumn(key, {})
      closePopover()
    }
    ok.addEventListener('click', confirm)
    name.addEventListener('keydown', e => { if (e.key === 'Enter') confirm() })
    popover.replaceChildren(h('div', { class: 'base-pop-list' }, h('div', { class: 'base-pop-row' }, name, list, type, ok)))
    popover.hidden = false
    popover.style.left = `${Math.max(0, anchor.offsetLeft - 200)}px`
    name.focus()
  }

  /**
   * Edition d'une colonne formule : son nom et son expression, avec un
   * apercu calcule sur la premiere ligne. `key` absente : nouvelle colonne.
   */
  const openFormulaEditor = (anchor: HTMLElement, key?: string) => {
    if (readOnly || !store.writable) return
    closePopover()
    popoverKind = 'formula'
    const existing = key ? formulaOf(key) : undefined
    const name = h('input', { class: 'base-input', placeholder: 'Nom de la colonne', 'data-testid': 'base-formula-name' })
    name.value = key ? key.slice(FORMULA_PREFIX.length) : ''
    const input = h('textarea', {
      class: 'base-input base-formula-input', rows: '3', spellcheck: 'false', 'data-testid': 'base-formula-input',
      placeholder: 'prop("Prix") * prop("Quantité")',
    })
    input.value = existing ?? ''
    const status = h('div', { class: 'base-formula-status', 'data-testid': 'base-formula-status' })
    const sample = table?.loadedRows()[0]
    const check = (): boolean => {
      const src = input.value
      if (!src.trim()) { status.textContent = 'Exemple : if(prop("Fait"), "✓", "") · dateAdd(prop("Début"), 7, "days")'; status.classList.remove('base-formula-bad'); return false }
      const c = compile(src)
      if ('error' in c) { status.textContent = c.error; status.classList.add('base-formula-bad'); return false }
      status.classList.remove('base-formula-bad')
      if (!sample) { status.textContent = 'Formule valide'; return true }
      const r = c.formula.evaluate(sample)
      status.textContent = r.ok ? `${sample.title || 'Première ligne'} → ${valueText(r.value) || '(vide)'}` : `${sample.title || 'Première ligne'} → ${r.error}`
      return true
    }
    input.addEventListener('input', check)
    const ok = h('button', { class: 'base-btn', type: 'button', 'data-testid': 'base-formula-ok' }, key && existing !== undefined ? 'Enregistrer' : 'Ajouter')
    const confirm = () => {
      const n = name.value.replace(/:/g, '').trim()
      if (!n) { name.focus(); return }
      if (!check()) { input.focus(); return }
      const newKey = FORMULA_PREFIX + n
      if (key && key !== newKey && existing !== undefined) {
        // Renommer : nouvelle cle a la meme place, l'ancienne retiree.
        const old = manifest.columns.find(c => c.key === key)
        store.setColumn(newKey, { formula: input.value, ...(old ? { width: old.width, order: old.order } : {}) })
        store.removeColumn(key)
      } else {
        store.setColumn(newKey, { formula: input.value })
      }
      closePopover()
    }
    ok.addEventListener('click', confirm)
    input.addEventListener('keydown', e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); confirm() } })
    name.addEventListener('keydown', e => { if (e.key === 'Enter') input.focus() })
    popover.replaceChildren(h('div', { class: 'base-pop-list base-formula', 'data-testid': 'base-formula-editor' },
      h('div', { class: 'base-pop-row' }, h('span', { class: 'base-pop-icon' }, 'ƒ'), name),
      input, status, h('div', { class: 'base-pop-row' }, ok)))
    popover.hidden = false
    popover.style.left = `${Math.max(0, anchor.offsetLeft - 200)}px`
    check()
    ;(name.value ? input : name).focus()
  }

  const openTotalMenu = (key: string, anchor: HTMLElement) => {
    if (readOnly || !store.writable) return
    const v = view()
    closePopover()
    popoverKind = 'total'
    const current = v.totals[key]
    const item = (text: string, kind: TotalKind | null) => {
      const b = h('button', { class: 'base-menu-item', type: 'button', 'data-testid': `base-total-${kind ?? 'none'}` }, `${text}${(current ?? null) === kind ? ' ✓' : ''}`)
      b.addEventListener('click', () => {
        closePopover()
        const totals = { ...v.totals }
        if (kind) totals[key] = kind
        else delete totals[key]
        store.setView(v.id, { totals })
      })
      return b
    }
    // Les calculs utiles au type de la colonne d'abord.
    const type = isFormulaKey(key) ? 'number' : typeOf(key)
    const kinds = TOTAL_KINDS.filter(t => type === 'checkbox' ? !['sum', 'mean', 'median', 'min', 'max'].includes(t.kind)
      : !['checked', 'unchecked'].includes(t.kind) && (type === 'number' || type === 'date' || !['sum', 'mean', 'median'].includes(t.kind)))
    popover.replaceChildren(h('div', { class: 'base-menu', 'data-testid': 'base-total-menu' },
      item('Aucun', null), ...kinds.map(t => item(t.label, t.kind))))
    popover.hidden = false
    // Sous le pied s'il reste de la place, sinon au-dessus.
    const box = container?.getBoundingClientRect() ?? { left: 0, top: 0, bottom: 0 }
    const at = anchor.getBoundingClientRect()
    popover.style.left = `${Math.max(0, at.left - box.left)}px`
    if (at.bottom + 320 <= box.bottom) popover.style.top = `${at.bottom - box.top + 4}px`
    else { popover.style.top = 'auto'; popover.style.bottom = `${Math.max(0, box.bottom - at.top + 4)}px` }
  }

  const openColumnMenu = (key: string, anchor: HTMLElement) => {
    if (isFormulaKey(key)) {
      const v = view()
      closePopover()
      popoverKind = 'column'
      const editable = !readOnly && store.writable
      const item = (text: string, testid: string, run: () => void) => {
        const b = h('button', { class: 'base-menu-item', type: 'button', 'data-testid': testid }, text)
        b.disabled = !editable
        b.addEventListener('click', () => { closePopover(); run() })
        return b
      }
      popover.replaceChildren(h('div', { class: 'base-menu', 'data-testid': 'base-column-menu' },
        item('Trier ↑', 'base-col-sort-asc', () => store.setView(v.id, { sorts: [{ key, dir: 'asc' }] })),
        item('Trier ↓', 'base-col-sort-desc', () => store.setView(v.id, { sorts: [{ key, dir: 'desc' }] })),
        item('ƒ Modifier la formule', 'base-col-formula', () => openFormulaEditor(anchor, key)),
        item('Masquer dans cette vue', 'base-col-hide', () => store.setView(v.id, { hidden: [...v.hidden, key] })),
        item('Retirer de la base', 'base-col-remove', () => store.removeColumn(key)),
      ))
      popover.hidden = false
      popover.style.left = `${anchor.offsetLeft}px`
      return
    }
    const v = view()
    closePopover()
    popoverKind = 'column'
    const item = (text: string, testid: string, run: () => void, enabled = true) => {
      const b = h('button', { class: 'base-menu-item', type: 'button', 'data-testid': testid }, text)
      b.disabled = !enabled
      b.addEventListener('click', () => { closePopover(); run() })
      return b
    }
    const editable = !readOnly && store.writable
    const menu = h('div', { class: 'base-menu', 'data-testid': 'base-column-menu' },
      item('Trier ↑', 'base-col-sort-asc', () => store.setView(v.id, { sorts: [{ key, dir: 'asc' }] }), editable),
      item('Trier ↓', 'base-col-sort-desc', () => store.setView(v.id, { sorts: [{ key, dir: 'desc' }] }), editable),
      key !== TITLE_COLUMN ? item('Masquer dans cette vue', 'base-col-hide', () => store.setView(v.id, { hidden: [...v.hidden, key] }), editable) : null,
      key !== TITLE_COLUMN && v.type === 'table' ? item('Grouper par (kanban)', 'base-col-group', () => store.setView(v.id, { type: 'kanban', groupBy: key }), editable) : null,
      key !== TITLE_COLUMN && types ? h('div', { class: 'base-menu-sub' }, 'Type (tout le vault)') : null,
      ...(key !== TITLE_COLUMN && types ? PROPERTY_TYPES.map(t => item(`${PROPERTY_TYPE_INFO[t].label}${typeOf(key) === t ? ' ✓' : ''}`, `base-col-type-${t}`, () => {
        types.set({ ...(types.get(key) ?? { key }), key, type: t })
      }, !readOnly)) : []),
      key !== TITLE_COLUMN ? item('Retirer de la base', 'base-col-remove', () => store.removeColumn(key), editable) : null,
    )
    popover.replaceChildren(menu)
    popover.hidden = false
    popover.style.left = `${anchor.offsetLeft}px`
  }

  // ── Mise a jour ──────────────────────────────────────────────────────────

  const update = () => {
    if (!container) return
    if (!manifest.views.some(v => v.id === activeId)) activeId = manifest.views[0].id
    renderToolbar()
    if (popoverKind && !['add-column', 'column', 'formula', 'total'].includes(popoverKind)) renderPopover()
    const v = view()
    if (!engine || !table || !kanban) {
      body.replaceChildren(h('div', { class: 'base-hint' }, 'Aucun moteur de requêtes : ouvrez un vault pour voir les lignes de la base.'))
      return
    }
    const q = query()
    const sig = formulaSig()
    const force = sig !== lastFormulaSig && needsFormulas(q)
    lastFormulaSig = sig
    if (v.type === 'kanban') {
      syncTotals(q, v)
      table.setQuery({ ...q, limit: 1 }, force)
      kanban.setQuery(q, v.groupBy, force)
      kanban.refresh()
      if (body.firstChild !== kanban.el) body.replaceChildren(kanban.el)
    } else {
      table.setQuery(q, force)
      syncTotals(q, v)
      table.refresh()
      if (body.firstChild !== table.el) body.replaceChildren(table.el)
    }
  }

  const handle: FileView & BaseViewHandle = {
    mount(el: HTMLElement) {
      container = el
      toolbar = h('div', { class: 'base-toolbar' })
      popover = h('div', { class: 'base-popover', 'data-testid': 'base-popover' })
      popover.hidden = true
      body = h('div', { class: 'base-body' })
      const footer = h('div', { class: 'base-footer' },
        h('span', { 'data-testid': 'base-count' }),
        h('span', { class: 'base-error', 'data-testid': 'base-error' }),
        !store.writable ? h('span', { class: 'base-hint' }, 'Base non synchronisée : réglages en lecture seule.') : null)
      const root = h('div', { class: 'base-view', 'data-testid': 'base-view' }, toolbar, popover, body, footer)
      root.addEventListener('focusin', () => { activeBaseView = handle })
      root.addEventListener('mousedown', e => {
        if (popoverKind && !popover.contains(e.target as Node) && !(e.target as HTMLElement).closest?.('.base-btn, .base-th-label, .base-th-add, .base-tf')) closePopover()
      })
      el.replaceChildren(root)
      activeBaseView = handle
      // Le manifeste arrive apres l'ouverture (changements distants) : on relit a chaque changement.
      unsubs.push(store.onChange(() => {
        manifest = readManifest(ctx.tree, defaultFolder)
        update()
      }))
      if (types) unsubs.push(types.onChange(() => update()))
      if (engine) unsubs.push(engine.onStateChange(s => { if (stateEl) stateEl.textContent = stateText(s) }))
      void types?.members?.().then(m => { members = m; table?.refresh(); kanban?.refresh() }).catch(() => {})
      update()
    },
    setReadOnly(ro: boolean) {
      readOnly = ro
      update()
      table?.refresh()
    },
    destroy() {
      for (const u of unsubs) u()
      unsubs.length = 0
      stopTotals()
      table?.destroy()
      kanban?.destroy()
      lightRows.close()
      if (activeBaseView === handle) activeBaseView = null
      container = null
    },
    addPage,
    addLightRow,
  }
  return handle
}
