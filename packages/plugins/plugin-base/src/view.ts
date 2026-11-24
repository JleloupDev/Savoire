// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// La vue d'un fichier .base : barre des vues (onglets), reglages de la vue
// (filtres, tris, regroupement, colonnes, source), puis le tableau ou le
// kanban. Les lignes viennent d'api.query (lignes-pages du dossier de la
// base + lignes legeres de ses lots), le manifeste du document (ctx.tree).
import {
  createIcon,
  AUTO_PROPERTY_TYPES, BASE_ROW_TITLE, DEFAULT_STATUS_OPTIONS, PROPERTY_TYPES, PROPERTY_TYPE_INFO, guessPropertyType, tryCompileFormula,
} from '@savoire/plugin-api'
import type {
  CompiledFormula,
  FileContext, FileView, IndexState, PluginAPI, PropertyMember, PropertyType, PropertyValue,
  Query, QueryFilter, QueryResult, QueryRow, QuerySort, QuerySource,
} from '@savoire/plugin-api'
import { h, valueText, type CellContext } from './cells'
import {
  DEFAULT_WIDTH, FORMULA_PREFIX, ManifestStore, TITLE_COLUMN, TITLE_WIDTH, defaultView, isFormulaKey, readManifest,
  type BaseManifest, type BaseSort, type BaseViewDef,
} from './manifest'
import { countFilters, isoDay, mapFilterKeys, toWhere, type FilterContext } from './filters'
import { renderFilterEditor, type FilterEditorHost } from './filterEditor'
import { LightRows } from './rows'
import { createPageRow, folderOfBase, renameNoteProperty, renamePageRow, writeNoteProperties, writeNoteProperty, type NotesVault } from './notes'
import { renderPropertySettings } from './propertySettings'
import { RelatedRows, asLinks, baseSourceOf, relationChoicesOf, rollupFormula, rowLink, syncBackLinks, ROLLUP_CALCS, type RollupCalc } from './relations'
import { BaseTable, type TableColumn } from './table'
import { BaseKanban } from './kanban'
import { needsFormulas, withFormulas } from './formulaEngine'
import { fetchBaseRows } from './queryBlock'
import { TOTAL_KINDS, computeTotal, totalText, type TotalKind } from './totals'
import { ensureStyle } from './style'
import { CELL_PROPOSAL, type CellProposal } from './proposals'
import { CellAnnotations, type CellCommentTarget } from './annotations'

/** Vue active d'une base, pour les commandes (la derniere qui a eu le focus). */
export let activeBaseView: BaseViewHandle | null = null

export interface BaseViewHandle {
  addPage(values?: Record<string, PropertyValue>): Promise<void>
  addLightRow(values?: Record<string, PropertyValue>): Promise<void>
}

function fieldOf(key: string): { prop: string } | { doc: 'title' } {
  return key === TITLE_COLUMN ? { doc: 'title' } : { prop: key }
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

  // ── Relations et rollups ─────────────────────────────────────────────────
  // Les lignes des bases visees par les relations, suivies en direct ; un
  // rollup se calcule sur elles (relations.ts).

  const pathOfBase = (id: string) => docVault?.getFileTree?.().find(e => e.docId === id)?.path
  const relationBase = (key: string): string | undefined => {
    const d = types?.get(key)
    return d?.type === 'relation' ? d.relation?.base : undefined
  }
  let onRelated: (base: string) => void = () => {}
  const related = engine ? new RelatedRows(
    engine,
    id => id === baseId ? Promise.resolve(source()) : baseSourceOf(api, id, pathOfBase(id)),
    id => onRelated(id),
  ) : null
  const rollups = new Map<string, { sig: string; formula: CompiledFormula }>()
  /** Une colonne calculee : formule ou rollup. */
  const computed = (key: string): { formula: CompiledFormula } | { error: string } => {
    const col = manifest.columns.find(c => c.key === key)
    if (col?.rollup && related) {
      const sig = JSON.stringify(col.rollup)
      let r = rollups.get(key)
      if (!r || r.sig !== sig) {
        const def = col.rollup
        r = { sig, formula: rollupFormula(def, () => relationBase(def.relation), related) }
        rollups.set(key, r)
      }
      return { formula: r.formula }
    }
    if (col?.rollup) return { error: 'Rollup indisponible sans moteur de requêtes.' }
    return compile(col?.formula ?? '')
  }
  /** Le moteur, plus les filtres et tris sur formules (calcules ici, voir formulaEngine). */
  const rowsEngine = engine && withFormulas(engine, key => {
    const f = computed(key)
    return 'formula' in f ? f.formula : undefined
  })
  /** Empreinte des formules : une formule modifiee relance une requete qui filtre ou trie dessus. */
  const formulaSig = () => JSON.stringify(manifest.columns.filter(c => isFormulaKey(c.key)).map(c => [c.key, c.formula, c.rollup]))
  let lastFormulaSig = ''

  /** Affichage du resultat d'un rollup : selon le type de la propriete resumee. */
  const rollupDisplay = (key: string): Pick<TableColumn, 'resultType' | 'resultKey'> => {
    const r = manifest.columns.find(c => c.key === key)?.rollup
    if (!r) return {}
    const target = r.prop === TITLE_COLUMN ? 'text' : typeOf(r.prop)
    if (r.calc === 'show') {
      const shown: Partial<Record<PropertyType, PropertyType>> = {
        select: 'multiselect', status: 'multiselect', multiselect: 'multiselect', person: 'person', createdBy: 'person', modifiedBy: 'person',
        relation: 'relation', link: 'relation', files: 'files',
      }
      return shown[target] ? { resultType: shown[target], resultKey: r.prop } : {}
    }
    if (['sum', 'mean', 'median', 'min', 'max'].includes(r.calc) && target === 'number') return { resultType: 'number', resultKey: r.prop }
    return {}
  }

  const allColumns = (): TableColumn[] => {
    const title: TableColumn = { key: TITLE_COLUMN, label: 'Nom', width: manifest.columns.find(c => c.key === TITLE_COLUMN)?.width ?? TITLE_WIDTH, type: 'text' }
    return [title, ...columnsOf(manifest).filter(c => c.key !== TITLE_COLUMN).map((c): TableColumn => {
      if (!isFormulaKey(c.key)) return { key: c.key, label: label(c.key), width: c.width, type: typeOf(c.key) }
      const f = computed(c.key)
      return {
        key: c.key, label: label(c.key), width: c.width, type: 'text', ...rollupDisplay(c.key),
        ...('formula' in f ? { formula: f.formula } : { formulaError: f.error }),
      }
    })]
  }
  const visibleColumns = (): TableColumn[] => allColumns().filter(c => c.key === TITLE_COLUMN || !view().hidden.includes(c.key))

  /** Dates relatives et « moi », resolues a chaque requete. */
  const filterCtx = (): FilterContext => ({ now: new Date(), me: api?.vault?.getCurrentUser?.()?.id, typeOf })
  /** Recherche rapide (barre de la vue) : pas enregistree, propre a cette personne. */
  let search = ''
  const source = (): QuerySource => {
    const where = toWhere(manifest.source.filters, manifest.source.filterMode, filterCtx())
    const folder = manifest.source.folder.replace(/\/+$/, '') || undefined
    if (baseId) return { base: baseId, pages: { folder, ext: ['md'], where } }
    return { notes: true, folder, ext: ['md'] }
  }
  const query = (): Query => {
    const v = view()
    const where = toWhere(v.filters, v.filterMode, filterCtx())
    const from = source()
    // Sans id de base, le filtre de source rejoint celui de la vue.
    const sourceWhere = 'notes' in from ? toWhere(manifest.source.filters, manifest.source.filterMode, filterCtx()) : undefined
    const all = [sourceWhere, where].filter((x): x is QueryFilter => !!x)
    return {
      from, where: all.length === 0 ? undefined : all.length === 1 ? all[0] : { and: all }, sort: toSort(v.sorts),
      ...(search.trim() ? { text: search.trim() } : {}),
    }
  }

  const knownValues = async (key: string): Promise<string[]> => {
    const options = types?.get(key)?.options?.map(o => o.value) ?? []
    if (!engine) return options
    try {
      const r = await engine.query({ from: source(), groupBy: { prop: key }, limit: 1 })
      return [...new Set([...options, ...(r.groups ?? []).map(g => g.key).filter((k): k is string => typeof k === 'string')])]
    } catch { return options }
  }
  /** Une valeur saisie dans un choix devient une option declaree (comme Notion). */
  const addOption = (key: string, value: string) => {
    if (!types || readOnly) return
    const d = types.get(key)
    const type = d?.type ?? typeOf(key)
    if (type !== 'select' && type !== 'multiselect' && type !== 'status') return
    const options = d?.options ?? []
    if (options.some(o => o.value === value)) return
    try {
      types.set({ ...(d ?? { key, type }), key, type, options: [...options, { value, ...(type === 'status' ? { group: 'todo' as const } : {}) }] })
    } catch { /* sans vault */ }
  }
  const upload = docVault?.uploadAttachment
    ? async (file: File) => {
      const p = await docVault.uploadAttachment!(file, { notePath: path })
      return `[[${docVault.linkTarget?.(p) ?? p}]]`
    }
    : undefined
  const cells = (): CellContext => ({
    members,
    knownValues,
    openLink: target => void api?.workspace.openFile(target),
    def: key => types?.get(key),
    addOption,
    ...(upload ? { upload } : {}),
    relationChoices: async (key, text) => {
      const target = relationBase(key)
      if (!target || !related) return []
      let rows = related.rows(target)
      // Premiere ouverture : on attend la lecture de la base visee.
      for (let i = 0; !rows && i < 40; i++) { await new Promise(r => setTimeout(r, 50)); rows = related.rows(target) }
      return relationChoicesOf(rows ?? [], text)
    },
    relationTitle: (key, link) => {
      const target = relationBase(key)
      return target ? related?.find(target, link)?.title : undefined
    },
  })

  // ── Valeurs posees par l'appli ───────────────────────────────────────────
  // Numero unique, cree le / par a la creation d'une ligne ; modifie le / par
  // a chaque modification faite depuis la base.

  const me = () => api?.vault?.getCurrentUser?.()?.id
  const pad2 = (n: number) => String(n).padStart(2, '0')
  const nowStamp = () => { const d = new Date(); return `${isoDay(d)}T${pad2(d.getHours())}:${pad2(d.getMinutes())}` }
  const autoColumns = (wanted: readonly string[]) => columnsOf(manifest)
    .filter(c => !isFormulaKey(c.key) && c.key !== TITLE_COLUMN && wanted.includes(typeOf(c.key)))
  const nextId = async (key: string): Promise<number> => {
    if (!engine) return 1
    try {
      const r = await engine.query({ from: source(), aggregate: [{ op: 'max', field: { prop: key } }], limit: 1 })
      const max = r.aggregates?.[0]
      return (typeof max === 'number' && Number.isFinite(max) ? Math.floor(max) : 0) + 1
    } catch { return 1 }
  }
  const creationValues = async (): Promise<Record<string, PropertyValue>> => {
    const out: Record<string, PropertyValue> = {}
    for (const c of autoColumns(AUTO_PROPERTY_TYPES)) {
      switch (typeOf(c.key)) {
        case 'created': case 'modified': out[c.key] = nowStamp(); break
        case 'createdBy': case 'modifiedBy': { const id = me(); if (id) out[c.key] = id; break }
        case 'id': out[c.key] = await nextId(c.key); break
      }
    }
    return out
  }
  const touchValues = (): Record<string, PropertyValue> => {
    const out: Record<string, PropertyValue> = {}
    for (const c of autoColumns(['modified', 'modifiedBy'])) {
      if (typeOf(c.key) === 'modified') out[c.key] = nowStamp()
      else { const id = me(); if (id) out[c.key] = id }
    }
    return out
  }

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
    // Mode suggestion : la valeur est proposee (Revision), pas ecrite.
    if (api?.review?.suggesting && baseId) {
      const before = (row.values?.[key] ?? null) as PropertyValue | null
      if (JSON.stringify(before) === JSON.stringify(value ?? null)) return
      const proposal: CellProposal = {
        row: row.path === '' ? { kind: 'light', baseId, rowId: row.id } : { kind: 'page', docId: row.id },
        title: row.title || row.id, key, before, after: value ?? null,
      }
      void api.review.propose(baseId, CELL_PROPOSAL, proposal).catch(report)
      return
    }
    // Relation dans les deux sens : les lignes liees pointent en retour.
    const rel = types?.get(key)
    if (rel?.type === 'relation' && rel.relation?.back && row.path !== '' && vault) {
      const target = rel.relation.base
      const back = rel.relation.back
      const resolve = (link: string) => related?.find(target, link)?.id ?? vault.resolveDocumentId(`${link.replace(/^\[\[|\]\]$/g, '').split('|')[0]}.md`)
      void syncBackLinks(vault, resolve, rowLink(row.path), row.id, back, asLinks(row.values[key]), asLinks(value)).catch(report)
    }
    const touch = touchValues()
    const many = Object.keys(touch).length > 0
    const job = row.path === ''
      ? (many ? lightRows.setCells(row.id, { [key]: value, ...touch }) : lightRows.setCell(row.id, key, value))
      : !vault ? Promise.reject(new Error('Aucun vault.'))
        : many ? writeNoteProperties(vault, row.id, { [key]: value, ...touch }) : writeNoteProperty(vault, row.id, key, value)
    void job.catch(report)
  }

  const rename = (row: QueryRow, title: string) => {
    if (readOnly || title === row.title) return
    // Mode suggestion : le nouveau nom est propose, comme une cellule.
    if (api?.review?.suggesting && baseId) {
      const proposal: CellProposal = {
        row: row.path === '' ? { kind: 'light', baseId, rowId: row.id } : { kind: 'page', docId: row.id, path: row.path },
        title: row.title || row.id, key: TITLE_COLUMN, before: row.title ?? null, after: title,
      }
      void api.review.propose(baseId, CELL_PROPOSAL, proposal).catch(report)
      return
    }
    const job = row.path === ''
      ? lightRows.setCell(row.id, BASE_ROW_TITLE, title)
      : vault ? renamePageRow(vault, row.id, row.path, title) : Promise.reject(new Error('Aucun vault.'))
    void job.catch(report)
  }

  const addPage = async (values: Record<string, PropertyValue> = {}) => {
    if (readOnly || !vault) return
    try {
      const own = Object.fromEntries(Object.entries(values).filter(([k]) => !isFormulaKey(k)))
      await createPageRow(vault, manifest.source.folder, 'Sans titre', { ...(await creationValues()), ...own })
    } catch (err) { report(err) }
  }

  const addLightRow = async (values: Record<string, PropertyValue> = {}) => {
    if (readOnly) return
    try {
      await lightRows.add('Sans titre', { ...(await creationValues()), ...values })
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

  // ── Revision dans la base ────────────────────────────────────────────────
  // Cellules commentees ou avec une valeur proposee : une marque, et leur fil
  // dans une carte posee sur la base (api.review), sans ouvrir le panneau.

  const review = api?.review
  const notes = new CellAnnotations()
  let card: HTMLElement | null = null
  let cardCleanup: (() => void) | null = null
  const inlineReview = () => !!review?.inline && !!baseId

  const closeCard = () => {
    cardCleanup?.()
    cardCleanup = null
    if (card) { card.hidden = true; card.replaceChildren() }
  }

  /** Place la carte sous la cellule `anchor`. */
  const placeCard = (anchor: HTMLElement): boolean => {
    if (!card || !container) return false
    const root = card.parentElement!.getBoundingClientRect()
    const rect = anchor.getBoundingClientRect()
    card.style.left = `${Math.max(0, Math.min(rect.left - root.left, root.width - 340))}px`
    card.style.top = `${rect.bottom - root.top + 4}px`
    card.hidden = false
    return true
  }

  const openAnnotations = (ids: string[], anchor: HTMLElement) => {
    if (!review?.renderAnnotation || !inlineReview()) return
    closeCard()
    if (!placeCard(anchor)) return
    cardCleanup = review.renderAnnotation(ids, card!, { onDone: closeCard })
  }

  const commentCell = (row: QueryRow, key: string, anchor: HTMLElement) => {
    if (!review?.renderDraft || !baseId || readOnly) return
    closeCard()
    if (!placeCard(anchor)) return
    const target: CellCommentTarget = { cell: { row: row.id, key }, quote: `${row.title || 'Sans titre'} · ${label(key)}` }
    try {
      cardCleanup = review.renderDraft(card!, { docId: baseId, kind: 'comment', quote: target.quote, target }, { onDone: closeCard })
    } catch (err) { closeCard(); report(err) }
  }

  const refreshAnnotations = () => {
    if (inlineReview()) notes.update(review!.annotations(baseId!))
    else { notes.clear(); closeCard() }
    table?.refresh()
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
    revision: () => relatedTick,
    annotation: (row, key) => notes.of(row.id, key),
    annotationSig: row => notes.rowSig(row.id),
    openAnnotations,
    decide: (id, accept) => {
      if (!review) return
      closeCard()
      void (accept ? review.accept(id) : review.reject(id)).catch(report)
    },
    ...(review?.renderDraft && baseId ? { commentCell } : {}),
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
    const f = computed(key)
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
    const key = JSON.stringify([q, wanted, formulaSig(), relatedTick])
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
    options: key => {
      const d = types?.get(key)
      const opts = d?.options ?? []
      // Statut : les options dans l'ordre de leurs groupes (a faire, en cours, termine).
      if (d?.type === 'status') {
        const rank = (g?: string) => ['todo', 'doing', 'done'].indexOf(g ?? 'todo')
        return [...opts].sort((a, b) => rank(a.group) - rank(b.group)).map(o => o.value)
      }
      return opts.map(o => o.value)
    },
    edit,
    open: row => void api?.workspace.openFile(row.path),
    addPage: values => void addPage(values),
    valueOf: (row, key) => cellValue(row, key),
  }) : null

  // Une base visee a change : les rollups se recalculent (et ce qui filtre ou trie dessus).
  let relatedTick = 0
  let relatedDirty = false
  onRelated = () => {
    relatedTick++
    relatedDirty = true
    update()
  }

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

  // Recherche rapide : le texte part au moteur (plein texte), sans toucher au manifeste.
  let searchInput: HTMLInputElement | null = null
  let searchTimer: ReturnType<typeof setTimeout> | null = null
  const searchBox = () => {
    if (!searchInput) {
      searchInput = h('input', { class: 'base-input base-search', type: 'search', placeholder: 'Rechercher…', 'data-testid': 'base-search' })
      searchInput.addEventListener('input', () => {
        if (searchTimer) clearTimeout(searchTimer)
        searchTimer = setTimeout(() => { searchTimer = null; search = searchInput!.value; update() }, 200)
      })
      searchInput.addEventListener('keydown', e => {
        e.stopPropagation()
        if (e.key === 'Escape') { searchInput!.value = ''; search = ''; update() }
      })
    }
    return searchInput
  }

  const filterHost = (): FilterEditorHost => ({
    editable: !readOnly && store.writable,
    keys: () => propertyChoices(true),
    label,
    typeOf: key => key === TITLE_COLUMN ? 'text' : isFormulaKey(key) ? 'text' : typeOf(key),
    members: () => members,
    knownValues,
    relationChoices: key => cells().relationChoices?.(key, '') ?? Promise.resolve([]),
  })

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
        const group = v.groupBy || cols.find(c => c.type === 'status')?.key || cols.find(c => c.type === 'select')?.key || cols.find(c => c.type === 'text')?.key || ''
        store.setView(v.id, { type: 'kanban', groupBy: group })
      }, v.type === 'kanban') : null,
      btn(`Filtrer${countFilters(v.filters) ? ` (${countFilters(v.filters)})` : ''}`, 'base-filter', b => togglePopover('filters', b), countFilters(v.filters) > 0),
      btn(`Trier${v.sorts.length ? ` (${v.sorts.length})` : ''}`, 'base-sort', b => togglePopover('sorts', b), v.sorts.length > 0),
      v.type === 'kanban' ? btn(`Grouper : ${v.groupBy ? label(v.groupBy) : '—'}`, 'base-group', b => togglePopover('group', b)) : null,
      btn('Colonnes', 'base-columns', b => togglePopover('columns', b)),
      btn('Source', 'base-source', b => togglePopover('source', b)),
      h('span', { class: 'base-spacer' }),
      searchBox(),
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

  const renderPopover = () => {
    const v = view()
    const editable = !readOnly && store.writable
    let content: HTMLElement
    switch (popoverKind) {
      case 'filters':
        content = renderFilterEditor(filterHost(), v.filterMode, v.filters, (filterMode, filters) => store.setView(v.id, { filters, filterMode }), 'base-filters')
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
          renderFilterEditor(filterHost(), manifest.source.filterMode, manifest.source.filters, (filterMode, filters) => store.setSource({ filters, filterMode }), 'base-source-filters'))
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
      h('option', { value: 'formula' }, 'ƒ Formule'),
      h('option', { value: 'rollup' }, '↗ Rollup'))
    name.addEventListener('input', () => { if (type.value !== 'formula' && type.value !== 'rollup') type.value = typeOf(name.value.trim()) })
    type.addEventListener('change', () => {
      const n = name.value.replace(/:/g, '').trim()
      if (type.value === 'formula') openFormulaEditor(anchor, n ? FORMULA_PREFIX + n : undefined)
      if (type.value === 'rollup') openRollupEditor(anchor, undefined, n)
    })
    const ok = h('button', { class: 'base-btn', type: 'button', 'data-testid': 'base-new-column-ok' }, 'Ajouter')
    const confirm = () => {
      const key = name.value.replace(/:/g, '').trim()
      if (!key || key === TITLE_COLUMN || isFormulaKey(key)) return
      if (types && !types.get(key) && type.value !== typeOf(key)) {
        const t = type.value as PropertyType
        try { types.set({ key, type: t, ...(t === 'status' ? { options: [...DEFAULT_STATUS_OPTIONS] } : {}) }) } catch { /* sans vault */ }
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

  /**
   * Edition d'un rollup : la relation, la propriete des lignes liees et le
   * calcul. `key` absente : nouvelle colonne.
   */
  const openRollupEditor = (anchor: HTMLElement, key?: string, initialName = '') => {
    if (readOnly || !store.writable) return
    closePopover()
    popoverKind = 'rollup'
    const existing = key ? manifest.columns.find(c => c.key === key)?.rollup : undefined
    const name = h('input', { class: 'base-input', placeholder: 'Nom de la colonne', 'data-testid': 'base-rollup-name' })
    name.value = key ? key.slice(FORMULA_PREFIX.length) : initialName
    const relations = propertyChoices(false).filter(k => !isFormulaKey(k) && typeOf(k) === 'relation')
    const relSelect = h('select', { class: 'base-input', 'data-testid': 'base-rollup-relation' },
      h('option', { value: '' }, '— relation —'), ...relations.map(k => h('option', { value: k }, label(k))))
    relSelect.value = existing?.relation ?? relations[0] ?? ''
    const propSelect = h('select', { class: 'base-input', 'data-testid': 'base-rollup-prop' })
    const calcSelect = h('select', { class: 'base-input', 'data-testid': 'base-rollup-calc' },
      ...ROLLUP_CALCS.map(c => h('option', { value: c.calc }, c.label)))
    calcSelect.value = existing?.calc ?? 'show'
    // Proprietes proposees : celles des lignes de la base visee.
    const fillProps = () => {
      const target = relationBase(relSelect.value)
      const rows = target ? related?.rows(target) : null
      const keys = new Set<string>()
      for (const r of rows ?? []) for (const k of Object.keys(r.values)) keys.add(k)
      if (existing?.prop && existing.prop !== TITLE_COLUMN) keys.add(existing.prop)
      const current = propSelect.value || existing?.prop || TITLE_COLUMN
      propSelect.replaceChildren(h('option', { value: TITLE_COLUMN }, 'Nom'), ...[...keys].sort().map(k => h('option', { value: k }, label(k))))
      propSelect.value = keys.has(current) || current === TITLE_COLUMN ? current : TITLE_COLUMN
      if (target && !rows) setTimeout(fillProps, 150)
    }
    relSelect.addEventListener('change', fillProps)
    fillProps()
    const hint = h('div', { class: 'base-pop-sub' }, relations.length ? 'Une propriété des lignes liées, affichée ou résumée.' : 'Ajoutez d’abord une propriété de type Relation.')
    const ok = h('button', { class: 'base-btn', type: 'button', 'data-testid': 'base-rollup-ok' }, key ? 'Enregistrer' : 'Ajouter')
    ok.addEventListener('click', () => {
      const n = name.value.replace(/:/g, '').trim()
      if (!n) { name.focus(); return }
      if (!relSelect.value) return
      const rollup = { relation: relSelect.value, prop: propSelect.value || TITLE_COLUMN, calc: calcSelect.value as RollupCalc }
      const newKey = FORMULA_PREFIX + n
      if (key && key !== newKey) {
        const old = manifest.columns.find(c => c.key === key)
        store.setColumn(newKey, { rollup, ...(old ? { width: old.width, order: old.order } : {}) })
        store.removeColumn(key)
      } else store.setColumn(newKey, { rollup })
      closePopover()
    })
    popover.replaceChildren(h('div', { class: 'base-pop-list', 'data-testid': 'base-rollup-editor' },
      h('div', { class: 'base-pop-row' }, h('span', { class: 'base-pop-icon' }, '↗'), name),
      h('div', { class: 'base-pop-row' }, 'Relation', relSelect),
      h('div', { class: 'base-pop-row' }, 'Propriété', propSelect),
      h('div', { class: 'base-pop-row' }, 'Calcul', calcSelect),
      hint, h('div', { class: 'base-pop-row' }, ok)))
    popover.hidden = false
    popover.style.left = `${Math.max(0, anchor.offsetLeft - 200)}px`
    name.focus()
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

  // ── Renommages dans toutes les lignes de la base ─────────────────────────

  const allRows = async (): Promise<QueryRow[]> => {
    if (!engine) return []
    return (await fetchBaseRows(engine, { from: source() })).rows
  }

  /** Renomme une propriete : lignes, type du vault, colonnes et vues. */
  const renameKey = async (from: string, to: string) => {
    if (readOnly || !vault) return
    for (const r of await allRows()) {
      if (r.values[from] === undefined) continue
      await (r.path === '' ? lightRows.renameKey(r.id, from, to) : renameNoteProperty(vault, r.id, from, to))
    }
    const d = types?.get(from)
    if (d && types && !types.get(to)) types.set({ ...d, key: to })
    const col = columnsOf(manifest).find(c => c.key === from)
    if (col) { store.setColumn(to, { width: col.width, order: col.order }); store.removeColumn(from) }
    const swap = (k: string) => k === from ? to : k
    for (const v of manifest.views) {
      store.setView(v.id, {
        filters: mapFilterKeys(v.filters, swap),
        sorts: v.sorts.map(x => ({ ...x, key: swap(x.key) })),
        hidden: v.hidden.map(swap),
        totals: Object.fromEntries(Object.entries(v.totals).map(([k, t]) => [swap(k), t])),
        groupBy: swap(v.groupBy),
      })
    }
    if (manifest.source.filters.length) store.setSource({ filters: mapFilterKeys(manifest.source.filters, swap) })
    closePopover()
  }

  /** Renomme une valeur (option) dans toutes les lignes de la base. */
  const renameValue = async (key: string, from: string, to: string) => {
    if (readOnly || !vault) return
    for (const r of await allRows()) {
      const v = r.values[key]
      let next: PropertyValue | undefined
      if (Array.isArray(v)) { if (v.includes(from)) next = v.map(x => x === from ? to : x) }
      else if (v === from) next = to
      if (next === undefined) continue
      await (r.path === '' ? lightRows.setCell(r.id, key, next) : writeNoteProperty(vault, r.id, key, next))
    }
  }

  const baseFiles = (): { id: string; path: string }[] => {
    const tree = docVault?.getFileTree?.() ?? []
    return tree.filter(e => e.path.toLowerCase().endsWith('.base') && !e.path.startsWith('.trash/'))
      .map(e => ({ id: e.docId, path: e.path })).sort((a, b) => a.path.localeCompare(b.path))
  }

  const openPropertySettings = (key: string, anchor: HTMLElement) => {
    if (!types) return
    closePopover()
    popoverKind = 'settings'
    const draw = () => {
      if (popoverKind !== 'settings') return
      popover.replaceChildren(renderPropertySettings({
        key,
        editable: !readOnly,
        def: () => types.get(key),
        type: () => typeOf(key),
        knownValues: () => knownValues(key),
        setDef: def => {
          types.set(def)
          // Relation dans les deux sens : la propriete en retour pointe vers cette base.
          const back = def.type === 'relation' ? def.relation?.back : undefined
          if (back && baseId && !types.get(back)) types.set({ key: back, type: 'relation', relation: { base: baseId, back: key } })
        },
        renameKey: next => renameKey(key, next),
        renameValue: (from, to) => renameValue(key, from, to),
        bases: baseFiles,
        selfBase: baseId,
        report,
      }))
    }
    settingsRedraw = draw
    draw()
    popover.hidden = false
    popover.style.left = `${Math.max(0, anchor.offsetLeft - 120)}px`
  }
  let settingsRedraw: (() => void) | null = null

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
        manifest.columns.find(c => c.key === key)?.rollup
          ? item('↗ Modifier le rollup', 'base-col-rollup', () => openRollupEditor(anchor, key))
          : item('ƒ Modifier la formule', 'base-col-formula', () => openFormulaEditor(anchor, key)),
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
      key !== TITLE_COLUMN && types ? item(`⚙ Propriété : ${PROPERTY_TYPE_INFO[typeOf(key)]?.label ?? typeOf(key)}…`, 'base-col-settings', () => openPropertySettings(key, anchor), !readOnly) : null,
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
    if (popoverKind && !['add-column', 'column', 'formula', 'rollup', 'total', 'settings'].includes(popoverKind)) renderPopover()
    const v = view()
    if (!engine || !table || !kanban) {
      body.replaceChildren(h('div', { class: 'base-hint' }, 'Aucun moteur de requêtes : ouvrez un vault pour voir les lignes de la base.'))
      return
    }
    const q = query()
    const sig = formulaSig()
    const force = (sig !== lastFormulaSig || relatedDirty) && needsFormulas(q)
    lastFormulaSig = sig
    relatedDirty = false
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
      card = h('div', { class: 'base-annotation annotation-card', 'data-testid': 'base-annotation' })
      card.hidden = true
      card.addEventListener('keydown', e => {
        e.stopPropagation()
        if (e.key === 'Escape') { e.preventDefault(); closeCard() }
      })
      const root = h('div', { class: 'base-view', 'data-testid': 'base-view' }, toolbar, popover, body, footer, card)
      root.addEventListener('focusin', () => { activeBaseView = handle })
      root.addEventListener('mousedown', e => {
        if (card && !card.hidden && !card.contains(e.target as Node) && !(e.target as HTMLElement).closest?.('[data-testid="base-cell-annotation"]')) closeCard()
        if (popoverKind && !popover.contains(e.target as Node) && !(e.target as HTMLElement).closest?.('.base-btn, .base-th-label, .base-th-add, .base-tf')) closePopover()
      })
      el.replaceChildren(root)
      activeBaseView = handle
      // Le manifeste arrive apres l'ouverture (changements distants) : on relit a chaque changement.
      unsubs.push(store.onChange(() => {
        manifest = readManifest(ctx.tree, defaultFolder)
        update()
      }))
      if (types) unsubs.push(types.onChange(() => { update(); if (popoverKind === 'settings') settingsRedraw?.() }))
      if (review && baseId) {
        unsubs.push(review.onChange(refreshAnnotations))
        unsubs.push(review.onInlineChange(refreshAnnotations))
        if (inlineReview()) notes.update(review.annotations(baseId))
      }
      if (engine) unsubs.push(engine.onStateChange(s => { if (stateEl) stateEl.textContent = stateText(s) }))
      void types?.members?.().then(m => { members = m; table?.refresh(); kanban?.refresh() }).catch(() => {})
      // Dates relatives (« aujourd'hui ») : la requete change avec le jour.
      let day = isoDay(new Date())
      const dayTimer = setInterval(() => { const d = isoDay(new Date()); if (d !== day) { day = d; update() } }, 60_000)
      unsubs.push(() => clearInterval(dayTimer))
      update()
    },
    setReadOnly(ro: boolean) {
      readOnly = ro
      update()
      table?.refresh()
    },
    destroy() {
      if (searchTimer) clearTimeout(searchTimer)
      closeCard()
      for (const u of unsubs) u()
      unsubs.length = 0
      stopTotals()
      table?.destroy()
      kanban?.destroy()
      related?.close()
      lightRows.close()
      if (activeBaseView === handle) activeBaseView = null
      container = null
    },
    addPage,
    addLightRow,
  }
  return handle
}
