// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// La vue d'un fichier .base : barre des vues (onglets), reglages de la vue
// (filtres, tris, regroupement, colonnes, source), puis le tableau ou le
// kanban. Les lignes viennent d'api.query (lignes-pages du dossier de la
// base + lignes legeres de ses lots), le manifeste du document (ctx.tree).
import {
  createIcon,
  AUTO_PROPERTY_TYPES, BASE_ROW_TITLE, DEFAULT_STATUS_OPTIONS, PROPERTY_TYPES, renderTemplate, setFrontmatterValue, PROPERTY_TYPE_INFO, guessPropertyType, tryCompileFormula,
} from '@savoire/plugin-api'
import type {
  CompiledFormula,
  FileContext, FileView, FormulaRow, IndexState, PluginAPI, PropertyMember, PropertyType, PropertyValue,
  Query, QueryFilter, QueryResult, QueryRow, QuerySort, QuerySource,
} from '@savoire/plugin-api'
import { h, openEditor, valueText, type CellContext } from './cells'
import {
  DEFAULT_WIDTH, FORMULA_PREFIX, MAX_MANUAL_ORDER, ManifestStore, RANK_KEY, TITLE_COLUMN, TITLE_WIDTH, VIEW_TYPES, defaultView, isFormulaKey, readManifest,
  type BaseManifest, type BaseSort, type BaseViewDef, type BaseViewType, type ChartKind, type TimelineScale,
} from './manifest'
import { countFilters, isoDay, mapFilterKeys, toWhere, type FilterContext } from './filters'
import { renderFilterEditor, type FilterEditorHost } from './filterEditor'
import { LightRows } from './rows'
import { createPageRow, folderOfBase, renameNoteProperty, renamePageRow, writeNoteProperties, writeNoteProperty, type NotesVault } from './notes'
import { renderPropertySettings } from './propertySettings'
import { RowPeek } from './peek'
import { cellCsv, parseCellText, parseCsv, toCsv } from './csv'
import {
  ACTION_KINDS, REPEATS, actionText, actionValues, dueTemplates, onAdded, templateFolder, triggered,
  type ActionDef, type AutomationDef, type Repeat,
} from './structure'
import { RelatedRows, asLinks, baseSourceOf, linkKey, relationChoicesOf, rollupFormula, rowLink, syncBackLinks, ROLLUP_CALCS, type RollupCalc } from './relations'
import { BaseTable, type TableColumn, type TableHost } from './table'
import { BaseKanban, type KanbanHost } from './kanban'
import { GroupedTable, type GroupSpec } from './groupedTable'
import { Swimlanes } from './swimlanes'
import { DATE_GROUPINGS, groupField, isDateType, type DateGrouping } from './groups'
import { BaseList } from './views/list'
import { BaseCalendar } from './views/calendar'
import { BaseTimeline } from './views/timeline'
import { BaseChart } from './views/chart'
import { BaseForm } from './views/form'
import type { LayoutHost } from './views/host'
import { needsFormulas, withFormulas } from './formulaEngine'
import { fetchBaseRows } from './queryBlock'
import { TOTAL_KINDS, computeTotal, totalText, type TotalKind } from './totals'
import { ensureStyle } from './style'
import { CELL_PROPOSAL, type CellProposal } from './proposals'
import { CellAnnotations, type CellCommentTarget } from './annotations'

/** Vue active d'une base, pour les commandes (la derniere qui a eu le focus). */
export let activeBaseView: BaseViewHandle | null = null

export interface BaseViewHandle {
  /** Les lignes de la vue en CSV (colonnes visibles). */
  exportCsv?(): Promise<string>
  /** Cree des lignes depuis un CSV ; rend leur nombre. */
  importCsv?(text: string): Promise<number>
  addPage(values?: Record<string, PropertyValue>, title?: string): Promise<void>
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

/** Base integree dans une note (vue liee). */
export interface EmbeddedOptions {
  /** Nom de la vue montree ; absent : la premiere. */
  view?: string
  /** Une vue propre a la page vient d'etre creee : reecrire le lien de la note. Rend false si impossible. */
  ownView?(name: string): boolean
  /** Ouvrir la base elle-meme. */
  openBase?(): void
}

export interface BaseViewOptions {
  embedded?: EmbeddedOptions
}

export function createBaseView(path: string, ctx: FileContext, api: PluginAPI | undefined, opts: BaseViewOptions = {}): FileView & BaseViewHandle {
  const embedded = opts.embedded
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
  /** Vue de depart : celle nommee par la note (base integree), sinon la premiere vue non liee. */
  const startView = (m: BaseManifest) => {
    const wanted = embedded?.view?.toLowerCase()
    return (wanted ? m.views.find(v => v.name.toLowerCase() === wanted) : undefined) ?? m.views.find(v => !v.linked) ?? m.views[0]
  }
  let activeId = startView(manifest).id
  /** Proprietes vues dans les lignes, par frequence : colonnes par defaut, choix proposes. */
  const seen = new Map<string, { count: number; sample: PropertyValue }>()
  let members: PropertyMember[] = []
  let container: HTMLElement | null = null
  const unsubs: (() => void)[] = []

  const discovered = () => [...seen.entries()].sort((a, b) => b[1].count - a[1].count).slice(0, 8).map(([key], i) => ({ key, width: DEFAULT_WIDTH, order: i + 1 }))
  /**
   * Colonnes de la base. Un manifeste sans aucune colonne de propriete (base
   * creee sur un dossier encore vide) montre celles des lignes, comme un
   * manifeste neuf ; elles s'ecrivent a la premiere modification des colonnes.
   */
  const columnsOf = (m: BaseManifest) => {
    if (!m.stored) return discovered()
    if (m.columns.some(c => c.key !== TITLE_COLUMN && !isFormulaKey(c.key))) return m.columns
    const extra = discovered()
    const maxOrder = Math.max(0, ...extra.map(c => c.order))
    return [...extra, ...m.columns.map(c => c.key === TITLE_COLUMN ? c : { ...c, order: c.order + maxOrder })]
  }

  const store = new ManifestStore(ctx.tree, () => ({ ...manifest, columns: columnsOf(manifest), views: manifest.views }))
  /** Colonnes, vues et reglages modifiables : ni lecture seule, ni structure verrouillee. */
  const canStructure = () => !readOnly && store.writable && !manifest.locked
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

  // Ordre manuel : le rang d'une ligne dans la liste de la vue (tri dans le client).
  let rankSig = ''
  let rankMap = new Map<string, number>()
  const rankOf = (id: string | undefined): number | null => {
    const order = view().rowOrder
    const sig = order.join('\u0000')
    if (sig !== rankSig) { rankSig = sig; rankMap = new Map(order.map((x, i) => [x, i])) }
    return id !== undefined && rankMap.has(id) ? rankMap.get(id)! : null
  }
  const rankFormula = {
    clientOnly: true as const,
    source: 'ordre manuel',
    props: [],
    aggregates: false,
    aggregateCalls: null,
    evaluateAggregates: () => ({ ok: false as const, error: 'Ordre manuel.' }),
    toFilter: () => null,
    evaluate: (row: FormulaRow) => ({ ok: true as const, value: rankOf((row as FormulaRow & { id?: string }).id) }),
  }
  /** Une colonne calculee : formule ou rollup. */
  const computed = (key: string): { formula: CompiledFormula } | { error: string } => {
    if (key === RANK_KEY) return { formula: rankFormula }
    const col = manifest.columns.find(c => c.key === key)
    if (col?.button) return compile(JSON.stringify(col.button.label))
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
  const formulaSig = () => JSON.stringify([manifest.columns.filter(c => isFormulaKey(c.key)).map(c => [c.key, c.formula, c.rollup]), view().rowOrder])
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
      const btn = manifest.columns.find(x => x.key === c.key)?.button
      return {
        key: c.key, label: label(c.key), width: c.width, type: 'text', ...rollupDisplay(c.key), ...(btn ? { button: { label: btn.label } } : {}),
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
    // Sous-elements : le tableau montre les lignes sans parent ; les enfants se deplient.
    const topLevel: QueryFilter | undefined = subItemsKey() && !search.trim() ? { field: { prop: subItemsKey() }, op: 'empty' } : undefined
    const all = [sourceWhere, where, topLevel].filter((x): x is QueryFilter => !!x)
    return {
      from, where: all.length === 0 ? undefined : all.length === 1 ? all[0] : { and: all },
      // Sans tri : l'ordre manuel s'il y en a un (les lignes hors liste a la fin, par nom).
      sort: v.sorts.length === 0 && v.rowOrder.length ? [{ field: { prop: RANK_KEY } }, { field: { doc: 'title' } }] : toSort(v.sorts),
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
  /** Adresse d'une image (couvertures) : pieces jointes du vault, ou du web telles quelles. */
  const imageUrl = async (ref: string): Promise<string | null> => {
    if (/^https?:\/\//i.test(ref)) return ref
    if (!docVault?.resolveAttachmentUrl) return null
    try { return await docVault.resolveAttachmentUrl(ref) } catch { return null }
  }
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
    // Automatisations : « quand cette propriete change » ajoute ses valeurs a la meme ecriture.
    const auto: Record<string, PropertyValue> = {}
    for (const a of triggered(manifest.automations, key, value)) Object.assign(auto, actionValues(a.then, actionCtx()))
    delete auto[key]
    writeValues(row, { [key]: value, ...auto, ...touchValues() })
  }

  /** Ecrit plusieurs valeurs d'une ligne en une fois (une seule modification de la note). */
  const writeValues = (row: QueryRow, values: Record<string, PropertyValue>) => {
    const keys = Object.keys(values)
    if (!keys.length) return
    const job = row.path === ''
      ? (keys.length > 1 ? lightRows.setCells(row.id, values) : lightRows.setCell(row.id, keys[0], values[keys[0]]))
      : !vault ? Promise.reject(new Error('Aucun vault.'))
        : keys.length > 1 ? writeNoteProperties(vault, row.id, values) : writeNoteProperty(vault, row.id, keys[0], values[keys[0]])
    void job.catch(report)
  }

  /** Contexte des actions (boutons, automatisations) : maintenant, moi. */
  const actionCtx = () => ({ now: nowStamp(), me: me(), multiple: (k: string) => !!types?.get(k)?.multiple })

  /** Un bouton : ses actions sur la ligne, plus les automatisations qu'elles declenchent. */
  const runButton = (row: QueryRow, key: string) => {
    if (readOnly) return
    const b = manifest.columns.find(c => c.key === key)?.button
    if (!b) return
    const values = actionValues(b.then, actionCtx())
    for (const [k, v] of Object.entries({ ...values })) {
      for (const a of triggered(manifest.automations, k, v)) for (const [k2, v2] of Object.entries(actionValues(a.then, actionCtx()))) if (!(k2 in values)) values[k2] = v2
    }
    writeValues(row, { ...values, ...touchValues() })
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

  /** Valeurs des automatisations « quand une page est ajoutee ». */
  const addedValues = (): Record<string, PropertyValue> => {
    const out: Record<string, PropertyValue> = {}
    for (const a of onAdded(manifest.automations)) Object.assign(out, actionValues(a.then, actionCtx()))
    return out
  }

  const addPage = async (values: Record<string, PropertyValue> = {}, title = 'Sans titre') => {
    if (readOnly || !vault) return
    // Le modele par defaut de la base, s'il y en a un.
    const tpl = manifest.templates.defaultTemplate
    if (tpl && docVault?.resolveDocumentId(tpl)) { await addFromTemplate(tpl, values, title); return }
    try {
      const own = Object.fromEntries(Object.entries(values).filter(([k]) => !isFormulaKey(k)))
      await createPageRow(vault, manifest.source.folder, title, { ...(await creationValues()), ...addedValues(), ...own })
    } catch (err) { report(err) }
  }

  // ── Modeles de ligne ─────────────────────────────────────────────────────
  // Les notes du dossier Modeles/<Base>/ : une nouvelle page en reprend le
  // texte (variables {{date}}, {{title}}...) et les proprietes.

  const baseLabel = () => defaultFolder.slice(defaultFolder.lastIndexOf('/') + 1) || 'Base'
  const templateFiles = (): { id: string; path: string; name: string }[] => {
    const folder = templateFolder(baseLabel()).toLowerCase() + '/'
    return (docVault?.getFileTree?.() ?? [])
      .filter(e => e.path.toLowerCase().startsWith(folder) && e.path.toLowerCase().endsWith('.md'))
      .map(e => ({ id: e.docId, path: e.path, name: e.path.slice(e.path.lastIndexOf('/') + 1).replace(/\.md$/i, '') }))
      .sort((a, b) => a.name.localeCompare(b.name))
  }

  /** Une page depuis un modele : son texte, puis les valeurs posees par la base. */
  const addFromTemplate = async (templatePath: string, values: Record<string, PropertyValue> = {}, title = 'Sans titre') => {
    if (readOnly || !vault || !docVault) return
    try {
      const id = docVault.resolveDocumentId(templatePath)
      if (!id) throw new Error(`Modèle introuvable : ${templatePath}`)
      const raw = await docVault.read(id)
      const created = await createPageRow(vault, manifest.source.folder, title)
      const name = created.path.slice(created.path.lastIndexOf('/') + 1).replace(/\.md$/i, '')
      const own = Object.fromEntries(Object.entries({ ...(await creationValues()), ...addedValues(), ...values }).filter(([k]) => !isFormulaKey(k)))
      await vault.editText?.(created.id, () => Object.entries(own).reduce(
        (md, [k, v]) => v === null || v === undefined ? md : setFrontmatterValue(md, k, v), renderTemplate(raw, { title: name })))
    } catch (err) { report(err) }
  }

  /** Nouveau modele : une note dans Modeles/<Base>/, ouverte pour l'ecrire. */
  const newTemplate = async () => {
    if (readOnly || !vault) return
    try {
      const folder = templateFolder(baseLabel())
      const props = Object.fromEntries(columnsOf(manifest).filter(c => c.key !== TITLE_COLUMN && !isFormulaKey(c.key) && !AUTO_PROPERTY_TYPES.includes(typeOf(c.key))).map(c => [c.key, null]))
      const { path: p } = await createPageRow(vault, folder, 'Modèle', props as Record<string, PropertyValue>)
      void api?.workspace.openFile(p)
    } catch (err) { report(err) }
  }

  /** Modeles repetes : une page par periode (jour, semaine, mois), creee a l'ouverture de la base. */
  let repeating = false
  const runRepeats = async () => {
    if (readOnly || repeating || !canStructure()) return
    const due = dueTemplates(manifest.templates, new Date())
    if (!due.length) return
    repeating = true
    try {
      const repeats = { ...manifest.templates.repeats }
      for (const d of due) repeats[d.path] = { ...repeats[d.path], last: d.period }
      // La periode est notee d'abord : un autre membre qui ouvre la base ne refait pas la page.
      store.setTemplates({ ...manifest.templates, repeats })
      for (const d of due) {
        if (!docVault?.resolveDocumentId(d.path)) continue
        const name = d.path.slice(d.path.lastIndexOf('/') + 1).replace(/\.md$/i, '')
        await addFromTemplate(d.path, {}, `${name} ${d.period}`)
      }
    } finally { repeating = false }
  }

  const addLightRow = async (values: Record<string, PropertyValue> = {}) => {
    if (readOnly) return
    try {
      await lightRows.add('Sans titre', { ...(await creationValues()), ...addedValues(), ...values })
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

  // ── Sous-elements ────────────────────────────────────────────────────────
  // Une relation vers la meme base porte le parent ; le tableau montre les
  // lignes sans parent, et deplie les enfants (nombre : par groupes du moteur).

  const subItemsKey = (): string => {
    const v = view()
    if (v.type !== 'table' || v.groupBy || !v.subItems) return ''
    return typeOf(v.subItems) === 'relation' ? v.subItems : ''
  }
  let childCounts = new Map<string, number>()
  let childStop: (() => void) | null = null
  let childSig = ''
  const followChildCounts = () => {
    const key = subItemsKey()
    const sig = key ? JSON.stringify([key, source()]) : ''
    if (sig === childSig) return
    childSig = sig
    childStop?.()
    childStop = null
    childCounts = new Map()
    if (!key || !engine) return
    childStop = engine.watch({ from: source(), groupBy: { prop: key }, limit: 1 }, r => {
      const next = new Map<string, number>()
      for (const g of r.groups ?? []) if (typeof g.key === 'string') next.set(linkKey(g.key), (next.get(linkKey(g.key)) ?? 0) + g.count)
      childCounts = next
      table?.refresh()
    })
  }

  /** Cree une relation vers cette base, avec sa propriete en retour (sous-elements, dependances). */
  const createSelfRelation = (key: string, back: string) => {
    if (!types || !baseId || readOnly) return
    try {
      if (!types.get(key)) types.set({ key, type: 'relation', relation: { base: baseId, back } })
      if (!types.get(back)) types.set({ key: back, type: 'relation', relation: { base: baseId, back: key } })
    } catch (err) { report(err) }
    for (const k of [key, back]) if (!columnsOf(manifest).some(c => c.key === k)) store.setColumn(k, {})
  }

  // ── Confort du tableau : colonnes, ordre, collage, selection ─────────────

  /** Deplace une colonne avant une autre ; les ordres sont renumerotes. */
  const moveColumn = (key: string, before: string) => {
    if (!canStructure() || key === before) return
    const cols = columnsOf(manifest).filter(c => c.key !== TITLE_COLUMN).sort((a, b) => a.order - b.order)
    const keys = cols.map(c => c.key).filter(k => k !== key)
    const i = keys.indexOf(before)
    keys.splice(i < 0 ? keys.length : i, 0, key)
    keys.forEach((k, n) => { if (cols.find(c => c.key === k)?.order !== n + 1) store.setColumn(k, { order: n + 1 }) })
  }

  /** Ordre manuel : `id` passe avant `before` (null : a la fin). */
  const reorderRows = (id: string, before: string | null, loaded: string[]) => {
    const v = view()
    const base = v.rowOrder.length ? [...v.rowOrder, ...loaded.filter(x => !v.rowOrder.includes(x))] : loaded
    const list = base.filter(x => x !== id)
    const i = before ? list.indexOf(before) : -1
    list.splice(i < 0 ? list.length : i, 0, id)
    store.setView(v.id, { rowOrder: list.slice(0, MAX_MANUAL_ORDER) })
  }

  /** Une valeur tapee ou collee, selon le type de la colonne. */
  const parseFor = (key: string, text: string): PropertyValue => parseCellText(typeOf(key), text, !!types?.get(key)?.multiple)

  /** Coller un tableau (tableur) a partir d'une cellule. */
  const pasteCells = (cells: { row: QueryRow; key: string; text: string }[]) => {
    if (readOnly) return
    const cols = allColumns()
    for (const c of cells) {
      if (c.key === TITLE_COLUMN) { if (c.text.trim()) rename(c.row, c.text.trim()); continue }
      const col = cols.find(x => x.key === c.key)
      if (!col || col.formula || col.formulaError || isFormulaKey(c.key) || AUTO_PROPERTY_TYPES.includes(col.type)) continue
      edit(c.row, c.key, parseFor(c.key, c.text))
    }
  }

  /** Lignes cochees dans le tableau. */
  let selection: QueryRow[] = []
  let bulk: HTMLElement | null = null
  const status = (text: string) => {
    const el = container?.querySelector('[data-testid="base-error"]')
    if (el) el.textContent = text
  }

  /** Met des lignes a la corbeille (pages) ou les retire (lignes legeres). */
  const removeRows = async (rows: QueryRow[]) => {
    if (readOnly) return
    let n = 0
    for (const r of rows) {
      try {
        if (r.path === '') await lightRows.remove(r.id)
        else if (docVault?.deleteFile) await docVault.deleteFile(r.id)
        else continue
        n++
      } catch (err) { report(err) }
    }
    status(n ? `${n} ligne${n > 1 ? 's' : ''} supprimée${n > 1 ? 's' : ''} (pages à la corbeille).` : '')
  }

  /** Copie des lignes : une page avec le meme texte, ou une ligne legere avec les memes valeurs. */
  const duplicateRows = async (rows: QueryRow[]) => {
    if (readOnly || !vault) return
    for (const r of rows) {
      try {
        if (r.path === '') {
          const full = await lightRows.get(r.id)
          if (full) await lightRows.add(`${full.title || 'Sans titre'} (copie)`, full.values)
          continue
        }
        const text = await docVault!.read(r.id)
        const folder = r.path.includes('/') ? r.path.slice(0, r.path.lastIndexOf('/')) : ''
        const { id } = await createPageRow(vault, folder, `${r.title || 'Sans titre'} (copie)`)
        await vault.editText?.(id, () => text)
      } catch (err) { report(err) }
    }
  }

  /** Une valeur pour toutes les lignes cochees. */
  const openBulkEdit = (anchor: HTMLElement) => {
    if (readOnly) return
    closePopover()
    popoverKind = 'bulk'
    const rows = selection
    const keys = allColumns().filter(c => c.key !== TITLE_COLUMN && !c.formula && !c.formulaError && !AUTO_PROPERTY_TYPES.includes(c.type)).map(c => c.key)
    const sel = h('select', { class: 'base-input', 'data-testid': 'base-bulk-key' }, h('option', { value: '' }, '— propriété —'), ...keys.map(k => h('option', { value: k }, label(k))))
    const slot = h('span', { class: 'base-bulk-slot', 'data-testid': 'base-bulk-slot' })
    sel.addEventListener('change', () => {
      const key = sel.value
      slot.replaceChildren()
      if (!key) return
      const type = typeOf(key)
      if (type === 'checkbox') {
        const on = h('button', { class: 'base-btn', type: 'button', 'data-testid': 'base-bulk-check' }, 'Cocher')
        const off = h('button', { class: 'base-btn', type: 'button' }, 'Décocher')
        on.addEventListener('click', () => { for (const r of rows) edit(r, key, true); closePopover() })
        off.addEventListener('click', () => { for (const r of rows) edit(r, key, false); closePopover() })
        slot.append(on, off)
        return
      }
      openEditor(slot, key, type, null, cells(), v => { for (const r of rows) edit(r, key, v); closePopover() }, () => {})
    })
    popover.replaceChildren(h('div', { class: 'base-pop-list', 'data-testid': 'base-bulk-editor' },
      h('div', { class: 'base-pop-sub' }, `${rows.length} ligne${rows.length > 1 ? 's' : ''}`),
      h('div', { class: 'base-pop-row' }, sel), slot))
    popover.hidden = false
    popover.style.left = `${anchor.offsetLeft}px`
  }

  const renderBulk = () => {
    if (!bulk) return
    bulk.hidden = selection.length === 0
    if (!selection.length) { bulk.replaceChildren(); return }
    const b = (text: string, testid: string, run: (el: HTMLElement) => void) => {
      const el = h('button', { class: 'base-btn', type: 'button', 'data-testid': testid }, text)
      el.disabled = readOnly
      el.addEventListener('click', () => run(el))
      return el
    }
    const n = selection.length
    bulk.replaceChildren(
      h('span', { class: 'base-bulk-count', 'data-testid': 'base-bulk-count' }, `${n} sélectionnée${n > 1 ? 's' : ''}`),
      b('Modifier…', 'base-bulk-edit', el => openBulkEdit(el)),
      b('Dupliquer', 'base-bulk-duplicate', () => { const rows = selection; table?.clearSelection(); void duplicateRows(rows) }),
      b('Supprimer', 'base-bulk-delete', () => { const rows = selection; table?.clearSelection(); void removeRows(rows) }),
      h('span', { class: 'base-spacer' }),
      b('✕', 'base-bulk-clear', () => table?.clearSelection()))
  }

  // ── Actions, automatisations, boutons ───────────────────────────────────

  /** Editeur d'une action : quoi faire, sur quelle propriete, avec quelle valeur. */
  const actionEditor = (initial: ActionDef | undefined, testid: string) => {
    const keys = propertyChoices(false).filter(k => !isFormulaKey(k) && !AUTO_PROPERTY_TYPES.includes(typeOf(k)))
    const kind = h('select', { class: 'base-input', 'data-testid': `${testid}-kind` }, ...ACTION_KINDS.map(a => h('option', { value: a.kind }, a.label)))
    kind.value = initial?.kind ?? 'set'
    const key = h('select', { class: 'base-input', 'data-testid': `${testid}-key` }, h('option', { value: '' }, '— propriété —'), ...keys.map(k => h('option', { value: k }, label(k))))
    key.value = initial?.key ?? ''
    const value = h('input', { class: 'base-input', placeholder: 'valeur', 'data-testid': `${testid}-value` })
    value.value = initial?.kind === 'set' ? valueText(initial.value) : ''
    const sync = () => { value.hidden = kind.value !== 'set' }
    kind.addEventListener('change', sync)
    sync()
    const el = h('div', { class: 'base-pop-row' }, kind, key, value)
    const read = (): ActionDef | null => {
      if (!key.value) return null
      if (kind.value === 'set') return { kind: 'set', key: key.value, value: parseFor(key.value, value.value) }
      return { kind: kind.value as 'now' | 'me' | 'clear', key: key.value }
    }
    return { el, read }
  }

  /** Les automatisations de la base : liste, activer, retirer, ajouter. */
  const openAutomations = (anchor: HTMLElement) => {
    closePopover()
    popoverKind = 'automations'
    const draw = () => {
      if (popoverKind !== 'automations') return
      const list = manifest.automations
      const rows = list.map(a => {
        const on = h('input', { type: 'checkbox', title: 'Active', 'data-testid': 'base-automation-on' })
        on.checked = a.enabled
        on.addEventListener('change', () => { store.setAutomations(list.map(x => x.id === a.id ? { ...x, enabled: on.checked } : x)); setTimeout(draw) })
        const del = h('button', { class: 'base-btn', type: 'button', title: 'Retirer', 'data-testid': 'base-automation-remove' }, '×')
        del.addEventListener('click', () => { store.setAutomations(list.filter(x => x.id !== a.id)); setTimeout(draw) })
        const when = a.when.kind === 'added' ? 'Quand une page est ajoutée'
          : `Quand ${label(a.when.key)} change${a.when.value !== undefined ? ` en « ${valueText(a.when.value)} »` : ''}`
        return h('div', { class: 'base-pop-row', 'data-testid': 'base-automation' }, on,
          h('span', { class: 'base-pop-label' }, `${when} : ${a.then.map(x => actionText(x, label)).join(', ')}`), del)
      })
      // Nouvelle automatisation.
      const trigger = h('select', { class: 'base-input', 'data-testid': 'base-automation-trigger' },
        h('option', { value: 'added' }, 'Quand une page est ajoutée'), h('option', { value: 'changed' }, 'Quand une propriété change'))
      const whenKey = propertySelect('', false, () => {}, 'base-automation-when-key')
      const whenValue = h('input', { class: 'base-input', placeholder: 'valeur (facultatif)', 'data-testid': 'base-automation-when-value' })
      const syncWhen = () => { whenKey.hidden = whenValue.hidden = trigger.value !== 'changed' }
      trigger.addEventListener('change', syncWhen)
      syncWhen()
      const action = actionEditor(undefined, 'base-automation-action')
      const add = h('button', { class: 'base-btn', type: 'button', 'data-testid': 'base-automation-add' }, 'Ajouter')
      add.addEventListener('click', () => {
        const then = action.read()
        if (!then) return
        const key = (whenKey as HTMLSelectElement).value
        if (trigger.value === 'changed' && !key) return
        const when: AutomationDef['when'] = trigger.value === 'added' ? { kind: 'added' }
          : { kind: 'changed', key, ...(whenValue.value.trim() ? { value: parseFor(key, whenValue.value) } : {}) }
        store.setAutomations([...list, { id: `a${Date.now().toString(36)}`, name: '', enabled: true, when, then: [then] }])
        setTimeout(draw)
      })
      popover.replaceChildren(h('div', { class: 'base-pop-list base-settings', 'data-testid': 'base-automations-editor' },
        h('div', { class: 'base-pop-sub' }, 'Automatisations'),
        ...(rows.length ? rows : [h('div', { class: 'base-hint' }, 'Aucune automatisation.')]),
        h('div', { class: 'base-pop-sub' }, 'Nouvelle'),
        h('div', { class: 'base-pop-row' }, trigger, whenKey, whenValue),
        h('div', { class: 'base-pop-sub' }, 'Alors'),
        action.el,
        h('div', { class: 'base-pop-row' }, add),
        h('div', { class: 'base-hint' }, 'Elles s’exécutent quand la modification est faite depuis la base.')))
    }
    draw()
    popover.hidden = false
    placePopover(anchor, 260)
  }

  /** Nouvelle colonne bouton (ou modification) : son libelle et son action. */
  const openButtonEditor = (anchor: HTMLElement, key?: string, initialName = '') => {
    if (!canStructure()) return
    closePopover()
    popoverKind = 'button'
    const existing = key ? manifest.columns.find(c => c.key === key)?.button : undefined
    const name = h('input', { class: 'base-input', placeholder: 'Nom de la colonne', 'data-testid': 'base-button-name' })
    name.value = key ? key.slice(FORMULA_PREFIX.length) : initialName
    const text = h('input', { class: 'base-input', placeholder: 'Libellé du bouton', 'data-testid': 'base-button-label' })
    text.value = existing?.label ?? ''
    const action = actionEditor(existing?.then[0], 'base-button-action')
    const ok = h('button', { class: 'base-btn', type: 'button', 'data-testid': 'base-button-ok' }, key ? 'Enregistrer' : 'Ajouter')
    ok.addEventListener('click', () => {
      const n = name.value.replace(/:/g, '').trim()
      const then = action.read()
      if (!n || !then) return
      const button = { label: text.value.trim() || n, then: [then] }
      const newKey = FORMULA_PREFIX + n
      if (key && key !== newKey) {
        const old = manifest.columns.find(c => c.key === key)
        store.setColumn(newKey, { button, ...(old ? { width: old.width, order: old.order } : {}) })
        store.removeColumn(key)
      } else store.setColumn(newKey, { button })
      closePopover()
    })
    popover.replaceChildren(h('div', { class: 'base-pop-list', 'data-testid': 'base-button-editor' },
      h('div', { class: 'base-pop-row' }, h('span', { class: 'base-pop-icon' }, '⏵'), name, text),
      h('div', { class: 'base-pop-sub' }, 'Au clic'), action.el, h('div', { class: 'base-pop-row' }, ok)))
    popover.hidden = false
    popover.style.left = `${Math.max(0, anchor.offsetLeft - 200)}px`
  }

  /** Menu des nouvelles pages : modeles, modele par defaut, repetition. */
  const openPageMenu = (anchor: HTMLElement) => {
    closePopover()
    popoverKind = 'pages'
    const draw = () => {
      if (popoverKind !== 'pages') return
      const files = templateFiles()
      const settings = manifest.templates
      const editable = canStructure()
      const rows = files.map(f => {
        const use = h('button', { class: 'base-menu-item', type: 'button', 'data-testid': 'base-template-use', 'data-path': f.path },
          `📄 ${f.name}${settings.defaultTemplate === f.path ? ' (par défaut)' : ''}`)
        use.addEventListener('click', () => { closePopover(); void addFromTemplate(f.path) })
        const def = h('input', { type: 'radio', name: 'base-default-template', title: 'Modèle par défaut', 'data-testid': 'base-template-default' })
        def.checked = settings.defaultTemplate === f.path
        def.disabled = !editable
        def.addEventListener('change', () => { store.setTemplates({ ...settings, defaultTemplate: f.path }); setTimeout(draw) })
        const rep = h('select', { class: 'base-input', title: 'Répéter', 'data-testid': 'base-template-repeat' }, ...REPEATS.map(r => h('option', { value: r.value }, r.label)))
        rep.value = settings.repeats[f.path]?.every ?? ''
        rep.disabled = !editable
        rep.addEventListener('change', () => {
          const repeats = { ...settings.repeats }
          // La periode en cours compte comme faite : la premiere page vient a la prochaine.
          if (rep.value) repeats[f.path] = { every: rep.value as Repeat, last: dueTemplates({ defaultTemplate: '', repeats: { x: { every: rep.value as Repeat, last: '' } } }, new Date())[0].period }
          else delete repeats[f.path]
          store.setTemplates({ ...settings, repeats })
        })
        const edit = h('button', { class: 'base-btn', type: 'button', title: 'Modifier le modèle' }, '✎')
        edit.addEventListener('click', () => { closePopover(); void api?.workspace.openFile(f.path) })
        return h('div', { class: 'base-pop-row', 'data-testid': 'base-template' }, def, use, rep, edit)
      })
      const none = h('button', { class: 'base-menu-item', type: 'button', 'data-testid': 'base-template-none' }, 'Page vide')
      none.addEventListener('click', () => { closePopover(); void addPage({}, 'Sans titre') })
      const noDefault = h('button', { class: 'base-btn', type: 'button', 'data-testid': 'base-template-no-default' }, 'Pas de modèle par défaut')
      noDefault.disabled = !editable || !settings.defaultTemplate
      noDefault.addEventListener('click', () => { store.setTemplates({ ...settings, defaultTemplate: '' }); setTimeout(draw) })
      const create = h('button', { class: 'base-btn', type: 'button', 'data-testid': 'base-template-new' }, '+ Nouveau modèle')
      create.disabled = readOnly
      create.addEventListener('click', () => { closePopover(); void newTemplate() })
      popover.replaceChildren(h('div', { class: 'base-pop-list base-settings', 'data-testid': 'base-page-menu' },
        h('div', { class: 'base-pop-sub' }, `Modèles (${templateFolder(baseLabel())}/)`),
        ...(rows.length ? rows : [h('div', { class: 'base-hint' }, 'Aucun modèle pour cette base.')]),
        h('div', { class: 'base-pop-row' }, create, noDefault),
        h('div', { class: 'base-hint' }, 'Un modèle répété crée sa page quand la base est ouverte.')))
      if (settings.defaultTemplate) popover.firstElementChild?.insertBefore(none, popover.firstElementChild.children[1] ?? null)
    }
    draw()
    popover.hidden = false
    placePopover(anchor, 260)
  }

  // ── CSV ──────────────────────────────────────────────────────────────────

  const baseName = () => defaultFolder.slice(defaultFolder.lastIndexOf('/') + 1) || 'base'

  /** Les lignes de la vue, colonnes visibles, en CSV. */
  const exportCsv = async (): Promise<string> => {
    if (!rowsEngine) return ''
    const cols = visibleColumns()
    const { rows } = await fetchBaseRows(rowsEngine, query())
    return toCsv([cols.map(c => c.label), ...rows.map(r => cols.map(c => cellCsv(cellValue(r, c.key))))])
  }

  const downloadCsv = async () => {
    try {
      const text = await exportCsv()
      const blob = new Blob(['\uFEFF' + text], { type: 'text/csv;charset=utf-8' })
      const url = URL.createObjectURL(blob)
      const a = h('a', { href: url, download: `${baseName()}.csv` })
      document.body.append(a)
      a.click()
      a.remove()
      setTimeout(() => URL.revokeObjectURL(url), 2000)
    } catch (err) { report(err) }
  }

  /**
   * Des lignes depuis un CSV : la premiere ligne nomme les proprietes ; la
   * colonne Nom (Name, Titre) donne le nom, sinon la premiere. Des pages, ou
   * des lignes legeres au-dela de 1000 lignes.
   */
  const importCsv = async (text: string): Promise<number> => {
    if (readOnly) return 0
    const [header, ...data] = parseCsv(text)
    if (!header?.length) return 0
    const keys = header.map(h => h.replace(/:/g, '').trim())
    let titleIdx = keys.findIndex(k => /^(nom|name|titre|title)$/i.test(k))
    if (titleIdx < 0) titleIdx = 0
    const props = keys.map((k, i) => i === titleIdx || !k ? null : k)
    const light = data.length > 1000 && lightRows.available
    let n = 0
    for (const line of data) {
      const values: Record<string, PropertyValue> = {}
      props.forEach((k, i) => {
        if (!k) return
        const v = parseFor(k, line[i] ?? '')
        if (v !== null) values[k] = v
      })
      const title = (line[titleIdx] ?? '').trim() || 'Sans titre'
      try {
        if (light) await lightRows.add(title, { ...(await creationValues()), ...values })
        else if (vault) await createPageRow(vault, manifest.source.folder, title, { ...(await creationValues()), ...values })
        n++
      } catch (err) { report(err); break }
    }
    // Les proprietes du fichier deviennent des colonnes.
    for (const k of props) if (k && !columnsOf(manifest).some(c => c.key === k)) store.setColumn(k, {})
    status(`${n} ligne${n > 1 ? 's' : ''} importée${n > 1 ? 's' : ''}.`)
    return n
  }

  const openMoreMenu = (anchor: HTMLElement) => {
    closePopover()
    popoverKind = 'more'
    const item = (text: string, testid: string, run: () => void, enabled = true) => {
      const b = h('button', { class: 'base-menu-item', type: 'button', 'data-testid': testid }, text)
      b.disabled = !enabled
      b.addEventListener('click', () => { closePopover(); run() })
      return b
    }
    const file = h('input', { type: 'file', accept: '.csv,text/csv,text/tab-separated-values', class: 'base-file-input', 'data-testid': 'base-import-file' })
    file.addEventListener('change', () => {
      const f = file.files?.[0]
      if (f) void f.text().then(importCsv).catch(report)
    })
    popover.replaceChildren(h('div', { class: 'base-menu', 'data-testid': 'base-more-menu' },
      item('Exporter la vue en CSV', 'base-export-csv', () => void downloadCsv()),
      item('Importer un CSV…', 'base-import-csv', () => file.click(), !readOnly),
      item('⚡ Automatisations…', 'base-automations', () => openAutomations(anchor), canStructure()),
      item(manifest.locked ? '🔓 Déverrouiller la structure' : '🔒 Verrouiller la structure', 'base-lock',
        () => store.setLocked(!manifest.locked), !readOnly && store.writable),
      file))
    popover.hidden = false
    placePopover(anchor, 120)
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

  const tableHost: TableHost | null = rowsEngine ? {
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
    moveColumn: (key, before) => moveColumn(key, before),
    frozen: () => view().frozen,
    wrap: () => view().wrap,
    selectionChanged: rows => { selection = rows; renderBulk() },
    peek: row => peekPanel.show(row),
    canReorder: () => canStructure() && view().sorts.length === 0,
    reorder: (id, before, order) => reorderRows(id, before, order),
    paste: cells => pasteCells(cells),
    runButton: (row, key) => runButton(row, key),
    locked: () => manifest.locked,
    childQuery: row => {
      const key = subItemsKey()
      if (!key || !row.path) return null
      const q = query()
      const child: QueryFilter = { field: { prop: key }, op: 'contains', value: rowLink(row.path) }
      const base = toWhere(view().filters, view().filterMode, filterCtx())
      return { from: q.from, where: base ? { and: [base, child] } : child, sort: q.sort }
    },
    childCount: row => row.path ? childCounts.get(linkKey(row.path)) ?? 0 : 0,
    addChild: row => { const key = subItemsKey(); if (key && row.path) void addPage({ [key]: [rowLink(row.path)] }) },
    annotation: (row, key) => notes.of(row.id, key),
    annotationSig: row => notes.rowSig(row.id),
    openAnnotations,
    decide: (id, accept) => {
      if (!review) return
      closeCard()
      void (accept ? review.accept(id) : review.reject(id)).catch(report)
    },
    ...(review?.renderDraft && baseId ? { commentCell } : {}),
  } : null
  const table = tableHost ? new BaseTable(tableHost) : null

  /** Replie ou deplie un groupe de la vue (tableau groupe, couloirs). */
  const toggleGroup = (id: string) => {
    if (!canStructure()) return
    const v = view()
    store.setView(v.id, { collapsed: v.collapsed.includes(id) ? v.collapsed.filter(x => x !== id) : [...v.collapsed, id] })
  }
  const groupedTable = tableHost ? new GroupedTable({ ...tableHost, toggleGroup, addPageIn: values => void addPage(values) }) : null
  /** Ce qu'il faut pour grouper sur une cle. */
  const groupSpec = (key: string, v: BaseViewDef): GroupSpec => {
    const type = key === TITLE_COLUMN ? 'text' : isFormulaKey(key) ? 'text' : typeOf(key)
    const dateGroup = isDateType(type) && v.dateGroup ? v.dateGroup : undefined
    const field = isFormulaKey(key) ? { prop: key } : groupField(key, type, dateGroup)
    return { key, type, field, options: types?.get(key)?.options ?? [], dateGroup, hideEmpty: v.hideEmpty, collapsed: v.collapsed }
  }

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
  const kanbanHost: KanbanHost | null = rowsEngine ? {
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
    coverOf: row => { const c = view().cover; return c ? cellValue(row, c) : undefined },
    imageUrl,
  } : null
  const kanban = kanbanHost ? new BaseKanban(kanbanHost) : null

  // ── Autres dispositions : liste, galerie, calendrier, frise, graphique, formulaire ──
  const layoutHost: LayoutHost | null = rowsEngine ? {
    engine: rowsEngine,
    readOnly: () => readOnly,
    columns: visibleColumns,
    cells,
    valueOf: (row, key) => cellValue(row, key),
    open: row => void api?.workspace.openFile(row.path),
    edit,
    addPage: (values, title) => addPage(values, title),
    imageUrl,
  } : null
  const list = layoutHost ? new BaseList(layoutHost) : null
  const calendar = layoutHost ? new BaseCalendar(layoutHost) : null
  const timeline = layoutHost ? new BaseTimeline(layoutHost) : null
  const chart = layoutHost ? new BaseChart(layoutHost) : null
  const peekPanel = new RowPeek({
    columns: allColumns,
    cells,
    readOnly: () => readOnly,
    typeOf,
    label,
    valueOf: (row, key) => cellValue(row, key),
    edit,
    rename,
    open: row => void api?.workspace.openFile(row.path),
    readBody: async row => row.path && docVault ? docVault.read(row.id) : null,
  }, () => {})
  // Le titre du formulaire : le nom de la base.
  const form = layoutHost ? new BaseForm(layoutHost, () => defaultFolder.slice(defaultFolder.lastIndexOf('/') + 1)) : null
  const swimlanes = kanbanHost ? new Swimlanes({ ...kanbanHost, toggleGroup }) : null

  // Une base visee a change : les rollups se recalculent (et ce qui filtre ou trie dessus).
  let relatedTick = 0
  let relatedDirty = false
  onRelated = () => {
    relatedTick++
    relatedDirty = true
    update()
  }

  const onResult = (r: QueryResult) => {
    if (peekPanel.current) peekPanel.update(r.rows.find(x => x.id === peekPanel.current!.id))
    let added = false
    for (const row of r.rows) {
      for (const [k, v] of Object.entries(row.values)) {
        const s = seen.get(k)
        if (s) { s.count++; if (s.sample === null) s.sample = v } else { seen.set(k, { count: 1, sample: v }); added = true }
      }
    }
    const count = container?.querySelector('[data-testid="base-count"]')
    if (count) count.textContent = `${r.total} ligne${r.total > 1 ? 's' : ''}`
    if (added && !manifest.columns.some(c => c.key !== TITLE_COLUMN && !isFormulaKey(c.key))) queueMicrotask(() => update())
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
    editable: canStructure(),
    keys: () => propertyChoices(true),
    label,
    typeOf: key => key === TITLE_COLUMN ? 'text' : isFormulaKey(key) ? 'text' : typeOf(key),
    members: () => members,
    knownValues,
    relationChoices: key => cells().relationChoices?.(key, '') ?? Promise.resolve([]),
  })

  /** Copie la vue montree en vue liee (masquee dans la base) et pointe le lien de la note dessus. */
  const makeOwnView = () => {
    const v = view()
    const names = new Set(manifest.views.map(x => x.name.toLowerCase()))
    let name = `${v.name} (page)`
    for (let n = 2; names.has(name.toLowerCase()); n++) name = `${v.name} (page ${n})`
    const id = `v${Date.now().toString(36)}`
    const order = Math.max(0, ...manifest.views.map(x => x.order)) + 1
    const { id: _from, ...copy } = v
    store.setView(id, { ...copy, name, order, linked: true })
    activeId = id
    if (!embedded?.ownView?.(name)) update()
  }

  /** Change la disposition d'une vue, avec des reglages par defaut utiles. */
  const setLayout = (v: BaseViewDef, type: BaseViewType) => {
    if (type === v.type) return
    const cols = allColumns().filter(c => c.key !== TITLE_COLUMN)
    const firstOf = (...kinds: PropertyType[]) => kinds.map(k => cols.find(c => !c.formula && c.type === k)?.key).find(Boolean) ?? ''
    const patch: Partial<BaseViewDef> = { type }
    if (type === 'table') patch.groupBy = ''
    // Kanban, graphique : la premiere propriete de choix, sinon le premier texte.
    if ((type === 'kanban' || type === 'chart') && !v.groupBy) patch.groupBy = firstOf('status', 'select', 'person', 'checkbox', 'text')
    if ((type === 'calendar' || type === 'timeline') && !v.dateBy) patch.dateBy = firstOf('date', 'created', 'modified')
    if ((type === 'gallery' || type === 'kanban') && !v.cover) patch.cover = firstOf('files')
    if (type !== 'kanban') patch.subGroupBy = ''
    store.setView(v.id, patch)
  }

  /** Reglages propres a la disposition (date du calendrier, couverture, axes du graphique...). */
  const layoutSettings = (v: BaseViewDef): HTMLElement => {
    const editable = canStructure()
    const keys = propertyChoices(false).filter(k => !isFormulaKey(k) || manifest.columns.some(c => c.key === k))
    const pick = (label: string, testid: string, value: string, filter: (k: string) => boolean, onChange: (v: string) => void, none = '—') => {
      const sel = h('select', { class: 'base-input', 'data-testid': testid }, h('option', { value: '' }, none), ...keys.filter(filter).map(k => h('option', { value: k }, label === '' ? k : labelOf(k))))
      sel.value = value
      sel.disabled = !editable
      sel.addEventListener('change', () => onChange(sel.value))
      return h('div', { class: 'base-pop-row' }, h('span', { class: 'base-setting-label' }, label), sel)
    }
    const choose = <T extends string>(label: string, testid: string, value: T, options: [T, string][], onChange: (v: T) => void) => {
      const sel = h('select', { class: 'base-input', 'data-testid': testid }, ...options.map(([o, l]) => h('option', { value: o }, l)))
      sel.value = value
      sel.disabled = !editable
      sel.addEventListener('change', () => onChange(sel.value as T))
      return h('div', { class: 'base-pop-row' }, h('span', { class: 'base-setting-label' }, label), sel)
    }
    const labelOf = (k: string) => label(k)
    const isDate = (k: string) => isDateType(typeOf(k))
    const set = (patch: Partial<BaseViewDef>) => store.setView(v.id, patch)
    const rows: (HTMLElement | null)[] = [h('div', { class: 'base-pop-sub' }, VIEW_TYPES.find(t => t.type === v.type)?.label ?? '')]
    switch (v.type) {
      case 'table': {
        rows.push(choose('Colonnes figées', 'base-layout-frozen', String(v.frozen) as '0', [['0', 'Aucune'], ['1', 'Le nom'], ['2', '2 colonnes'], ['3', '3 colonnes'], ['4', '4 colonnes']], f => set({ frozen: Number(f) })))
        const wrap = h('input', { type: 'checkbox', 'data-testid': 'base-layout-wrap' })
        wrap.checked = v.wrap
        wrap.disabled = !editable
        wrap.addEventListener('change', () => set({ wrap: wrap.checked }))
        rows.push(h('label', { class: 'base-pop-row' }, wrap, 'Retour à la ligne dans les cellules'))
        rows.push(pick('Sous-éléments', 'base-layout-subitems', v.subItems, k => typeOf(k) === 'relation', subItems => set({ subItems }), 'Aucun'))
        if (!v.subItems && editable) {
          const mk = h('button', { class: 'base-btn', type: 'button', 'data-testid': 'base-layout-make-subitems' }, 'Créer « Parent » et « Sous-éléments »')
          mk.addEventListener('click', () => { createSelfRelation('Parent', 'Sous-éléments'); set({ subItems: 'Parent' }) })
          rows.push(mk)
        }
        if (v.rowOrder.length) {
          const reset = h('button', { class: 'base-btn', type: 'button', 'data-testid': 'base-layout-reset-order' }, 'Oublier l’ordre manuel')
          reset.disabled = !editable
          reset.addEventListener('click', () => set({ rowOrder: [] }))
          rows.push(reset)
        }
        break
      }
      case 'gallery':
        rows.push(pick('Couverture', 'base-layout-cover', v.cover, k => !isFormulaKey(k), cover => set({ cover }), 'Aucune'))
        rows.push(choose('Taille des cartes', 'base-layout-size', v.cardSize, [['small', 'Petites'], ['medium', 'Moyennes'], ['large', 'Grandes']], cardSize => set({ cardSize })))
        break
      case 'kanban':
        rows.push(pick('Couverture', 'base-layout-cover', v.cover, k => !isFormulaKey(k), cover => set({ cover }), 'Aucune'))
        break
      case 'calendar':
        rows.push(pick('Date', 'base-layout-date', v.dateBy, isDate, dateBy => set({ dateBy })))
        break
      case 'timeline':
        rows.push(pick('Début', 'base-layout-date', v.dateBy, isDate, dateBy => set({ dateBy })))
        rows.push(pick('Fin', 'base-layout-end', v.endBy, isDate, endBy => set({ endBy }), 'Fin de la période'))
        rows.push(choose('Échelle', 'base-layout-scale', v.scale, [['day', 'Jours'], ['week', 'Semaines'], ['month', 'Mois']], scale => set({ scale: scale as TimelineScale })))
        rows.push(pick('Dépendances', 'base-layout-deps', v.dependsOn, k => typeOf(k) === 'relation', dependsOn => set({ dependsOn }), 'Aucune'))
        if (!v.dependsOn && editable) {
          const mk = h('button', { class: 'base-btn', type: 'button', 'data-testid': 'base-layout-make-deps' }, 'Créer « Bloque » et « Bloqué par »')
          mk.addEventListener('click', () => { createSelfRelation('Bloque', 'Bloqué par'); set({ dependsOn: 'Bloque' }) })
          rows.push(mk)
        }
        break
      case 'chart':
        rows.push(choose('Forme', 'base-layout-chart', v.chartKind, [['bar', 'Barres'], ['hbar', 'Barres horizontales'], ['line', 'Courbe'], ['donut', 'Anneau']], chartKind => set({ chartKind: chartKind as ChartKind })))
        rows.push(pick('Axe', 'base-layout-x', v.groupBy, k => !isFormulaKey(k), groupBy => set({ groupBy })))
        if (v.groupBy && isDate(v.groupBy)) rows.push(choose('Par', 'base-layout-dategroup', v.dateGroup, [['', 'Jour exact'], ...DATE_GROUPINGS.map(d => [d.value, d.label] as [DateGrouping, string])], dateGroup => set({ dateGroup: dateGroup as DateGrouping | '' })))
        rows.push(pick('Mesure', 'base-layout-y', v.chartY, k => isFormulaKey(k) || typeOf(k) === 'number', chartY => set({ chartY }), 'Nombre de lignes'))
        if (v.chartY) rows.push(choose('Calcul', 'base-layout-calc', v.chartCalc, [['sum', 'Somme'], ['mean', 'Moyenne'], ['min', 'Minimum'], ['max', 'Maximum']], chartCalc => set({ chartCalc })))
        break
      default:
        rows.push(h('div', { class: 'base-hint' }, 'Pas de réglage propre à cette disposition.'))
    }
    return h('div', { class: 'base-pop-list', 'data-testid': 'base-layout-settings' }, ...rows)
  }

  const renderToolbar = () => {
    // Integree : seulement sa vue. Dans la base : les vues non liees (et l'active).
    const shown = embedded ? manifest.views.filter(v => v.id === activeId) : manifest.views.filter(v => !v.linked || v.id === activeId)
    const tabs = h('div', { class: 'base-tabs' }, ...shown.map(v => {
      const tab = h('button', { class: v.id === activeId ? 'base-tab base-tab-active' : 'base-tab', type: 'button', 'data-testid': 'base-tab', 'data-id': v.id },
        `${VIEW_TYPES.find(t => t.type === v.type)?.glyph ?? '▦'} ${v.name}`)
      tab.addEventListener('click', () => { activeId = v.id; update() })
      tab.addEventListener('dblclick', () => {
        // Integree, le nom de la vue est dans le lien de la note : on ne le change pas d'ici.
        if (!canStructure() || embedded) return
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
    if (embedded) {
      const cur = view()
      if (!cur.linked && canStructure() && embedded.ownView) {
        const own = h('button', { class: 'base-tab base-tab-add', type: 'button', title: 'Filtres et tris propres à cette page', 'data-testid': 'base-own-view' }, 'Vue propre à cette page')
        own.addEventListener('click', () => makeOwnView())
        tabs.append(own)
      }
      if (embedded.openBase) {
        const open = h('button', { class: 'base-tab', type: 'button', 'data-testid': 'base-open-base' }, `↗ ${baseLabel()}`)
        open.addEventListener('click', () => embedded.openBase!())
        tabs.append(open)
      }
    } else if (canStructure()) {
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
    const editable = canStructure()
    const actions = h('div', { class: 'base-actions' },
      editable ? h('span', { class: 'base-layouts' }, ...VIEW_TYPES.map(t => {
        const b = btn(t.type === v.type ? `${t.glyph} ${t.label}` : t.glyph, `base-type-${t.type}`, () => setLayout(v, t.type), t.type === v.type)
        b.title = t.label
        return b
      })) : null,
      ['table', 'kanban', 'gallery', 'calendar', 'timeline', 'chart'].includes(v.type) ? btn('⚙ Vue', 'base-view-settings', b => togglePopover('layout', b)) : null,
      btn(`Filtrer${countFilters(v.filters) ? ` (${countFilters(v.filters)})` : ''}`, 'base-filter', b => togglePopover('filters', b), countFilters(v.filters) > 0),
      btn(`Trier${v.sorts.length ? ` (${v.sorts.length})` : ''}`, 'base-sort', b => togglePopover('sorts', b), v.sorts.length > 0),
      v.type === 'table' || v.type === 'kanban' ? btn(v.groupBy ? `Grouper : ${label(v.groupBy)}${v.type === 'kanban' && v.subGroupBy ? ` · ${label(v.subGroupBy)}` : ''}` : 'Grouper', 'base-group', b => togglePopover('group', b), !!v.groupBy && v.type !== 'kanban') : null,
      btn('Colonnes', 'base-columns', b => togglePopover('columns', b)),
      btn('Source', 'base-source', b => togglePopover('source', b)),
      btn('⋯', 'base-more', b => { if (popoverKind === 'more') closePopover(); else openMoreMenu(b) }),
      h('span', { class: 'base-spacer' }),
      searchBox(),
      stateEl = h('span', { class: 'base-state', 'data-testid': 'base-index-state' }),
      btn('+ Page', 'base-new-page', () => void addPage()),
      btn('▾', 'base-new-page-menu', b => { if (popoverKind === 'pages') closePopover(); else openPageMenu(b) }),
      lightRows.available ? btn('+ Ligne', 'base-new-row', () => void addLightRow()) : null,
    )
    toolbar.replaceChildren(tabs, actions)
    if (engine) stateEl.textContent = stateText(engine.state())
  }

  // ── Fenetres de reglage ──────────────────────────────────────────────────

  let popoverKind: string | null = null
  /** Pose la fenetre pres de son bouton, sans deborder de la vue. */
  const placePopover = (anchor: HTMLElement, shift = 0) => {
    const max = (container?.clientWidth ?? 0) - popover.offsetWidth - 8
    popover.style.left = `${Math.max(0, max > 0 ? Math.min(anchor.offsetLeft - shift, max) : anchor.offsetLeft - shift)}px`
  }
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

  const propertySelect = (value: string, withTitle: boolean, onChange: (v: string) => void, testid?: string) => {
    const select = h('select', { class: 'base-input', ...(testid ? { 'data-testid': testid } : {}) })
    select.append(h('option', { value: '' }, '—'), ...propertyChoices(withTitle).map(k => h('option', { value: k }, label(k))))
    select.value = value
    select.disabled = !canStructure()
    select.addEventListener('change', () => onChange(select.value))
    return select
  }

  const renderPopover = () => {
    const v = view()
    const editable = canStructure()
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
      case 'group': {
        const gtype = v.groupBy ? (isFormulaKey(v.groupBy) ? 'text' : typeOf(v.groupBy)) : 'text'
        const dates = h('select', { class: 'base-input', 'data-testid': 'base-group-date' },
          h('option', { value: '' }, 'Valeur exacte'), ...DATE_GROUPINGS.map(d => h('option', { value: d.value }, d.label)))
        dates.value = v.dateGroup
        dates.disabled = !editable
        dates.addEventListener('change', () => store.setView(v.id, { dateGroup: dates.value as DateGrouping | '' }))
        const hide = h('input', { type: 'checkbox', 'data-testid': 'base-group-hide-empty' })
        hide.checked = v.hideEmpty
        hide.disabled = !editable
        hide.addEventListener('change', () => store.setView(v.id, { hideEmpty: hide.checked }))
        content = h('div', { class: 'base-pop-list', 'data-testid': 'base-group-settings' },
          h('div', { class: 'base-pop-row' }, v.type === 'kanban' ? 'Colonnes' : 'Grouper par',
            propertySelect(v.groupBy, false, groupBy => store.setView(v.id, { groupBy, collapsed: [] }), 'base-group-by')),
          isDateType(gtype) ? h('div', { class: 'base-pop-row' }, 'Par', dates) : null,
          v.type === 'kanban' ? h('div', { class: 'base-pop-row' }, 'Sous-groupes',
            propertySelect(v.subGroupBy, false, subGroupBy => store.setView(v.id, { subGroupBy, collapsed: [] }), 'base-subgroup-by')) : null,
          h('label', { class: 'base-pop-row' }, hide, 'Masquer les groupes vides'))
        break
      }
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
      case 'layout':
        content = layoutSettings(v)
        break
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
    if (!canStructure()) return
    closePopover()
    popoverKind = 'add-column'
    const name = h('input', { class: 'base-input', placeholder: 'Propriété', 'data-testid': 'base-new-column-name', list: 'base-props-list' })
    const list = h('datalist', { id: 'base-props-list' }, ...propertyChoices(false).map(k => h('option', { value: k })))
    const type = h('select', { class: 'base-input', 'data-testid': 'base-new-column-type' },
      ...PROPERTY_TYPES.map(t => h('option', { value: t }, PROPERTY_TYPE_INFO[t].label)),
      h('option', { value: 'formula' }, 'ƒ Formule'),
      h('option', { value: 'rollup' }, '↗ Rollup'),
      h('option', { value: 'button' }, '⏵ Bouton'))
    name.addEventListener('input', () => { if (!['formula', 'rollup', 'button'].includes(type.value)) type.value = typeOf(name.value.trim()) })
    type.addEventListener('change', () => {
      const n = name.value.replace(/:/g, '').trim()
      if (type.value === 'formula') openFormulaEditor(anchor, n ? FORMULA_PREFIX + n : undefined)
      if (type.value === 'rollup') openRollupEditor(anchor, undefined, n)
      if (type.value === 'button') openButtonEditor(anchor, undefined, n)
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
    if (!canStructure()) return
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
    if (!canStructure()) return
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
    if (!canStructure()) return
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
        editable: !readOnly && !manifest.locked,
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
    placePopover(anchor, 120)
  }
  let settingsRedraw: (() => void) | null = null

  const openColumnMenu = (key: string, anchor: HTMLElement) => {
    if (isFormulaKey(key)) {
      const v = view()
      closePopover()
      popoverKind = 'column'
      const editable = canStructure()
      const item = (text: string, testid: string, run: () => void) => {
        const b = h('button', { class: 'base-menu-item', type: 'button', 'data-testid': testid }, text)
        b.disabled = !editable
        b.addEventListener('click', () => { closePopover(); run() })
        return b
      }
      popover.replaceChildren(h('div', { class: 'base-menu', 'data-testid': 'base-column-menu' },
        item('Trier ↑', 'base-col-sort-asc', () => store.setView(v.id, { sorts: [{ key, dir: 'asc' }] })),
        item('Trier ↓', 'base-col-sort-desc', () => store.setView(v.id, { sorts: [{ key, dir: 'desc' }] })),
        manifest.columns.find(c => c.key === key)?.button
          ? item('⏵ Modifier le bouton', 'base-col-button', () => openButtonEditor(anchor, key))
          : manifest.columns.find(c => c.key === key)?.rollup
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
    const editable = canStructure()
    const menu = h('div', { class: 'base-menu', 'data-testid': 'base-column-menu' },
      item('Trier ↑', 'base-col-sort-asc', () => store.setView(v.id, { sorts: [{ key, dir: 'asc' }] }), editable),
      item('Trier ↓', 'base-col-sort-desc', () => store.setView(v.id, { sorts: [{ key, dir: 'desc' }] }), editable),
      key !== TITLE_COLUMN ? item('Masquer dans cette vue', 'base-col-hide', () => store.setView(v.id, { hidden: [...v.hidden, key] }), editable) : null,
      v.type === 'table' ? item(visibleColumns().findIndex(c => c.key === key) + 1 === v.frozen ? 'Ne plus figer' : 'Figer jusqu’à cette colonne', 'base-col-freeze', () => {
        const n = visibleColumns().findIndex(c => c.key === key) + 1
        store.setView(v.id, { frozen: n === v.frozen ? 0 : n })
      }, editable) : null,
      key !== TITLE_COLUMN && v.type === 'table' ? item(v.groupBy === key ? 'Ne plus grouper' : 'Grouper par cette propriété', 'base-col-group', () => store.setView(v.id, { groupBy: v.groupBy === key ? '' : key, collapsed: [] }), editable) : null,
      key !== TITLE_COLUMN && types ? item(`⚙ Propriété : ${PROPERTY_TYPE_INFO[typeOf(key)]?.label ?? typeOf(key)}…`, 'base-col-settings', () => openPropertySettings(key, anchor), !readOnly && !manifest.locked) : null,
      key !== TITLE_COLUMN ? item('Retirer de la base', 'base-col-remove', () => store.removeColumn(key), editable) : null,
    )
    popover.replaceChildren(menu)
    popover.hidden = false
    popover.style.left = `${anchor.offsetLeft}px`
  }

  // ── Mise a jour ──────────────────────────────────────────────────────────

  const update = () => {
    if (!container) return
    if (!manifest.views.some(v => v.id === activeId)) activeId = startView(manifest).id
    renderToolbar()
    if (popoverKind && !['add-column', 'column', 'formula', 'rollup', 'button', 'total', 'settings', 'bulk', 'more', 'automations', 'pages'].includes(popoverKind)) renderPopover()
    const v = view()
    if (!engine || !table || !kanban) {
      body.replaceChildren(h('div', { class: 'base-hint' }, 'Aucun moteur de requêtes : ouvrez un vault pour voir les lignes de la base.'))
      return
    }
    followChildCounts()
    const q = query()
    const sig = formulaSig()
    const force = (sig !== lastFormulaSig || relatedDirty) && needsFormulas(q)
    lastFormulaSig = sig
    relatedDirty = false
    // Une seule disposition vit a la fois : les autres rendent leurs abonnements.
    const keep = (active: string) => {
      if (active !== 'kanban') kanban.destroy()
      if (active !== 'swimlanes') swimlanes?.destroy()
      if (active !== 'grouped') groupedTable?.destroy()
      if (active !== 'list') list?.destroy()
      if (active !== 'calendar') calendar?.destroy()
      if (active !== 'timeline') timeline?.destroy()
      if (active !== 'chart') chart?.destroy()
      if (active !== 'form') form?.destroy()
    }
    const show = (el: HTMLElement) => { if (body.firstChild !== el) body.replaceChildren(el) }
    // Hors tableau, le tableau principal ne sert qu'au compte des lignes.
    if (v.type !== 'table') table.setQuery({ ...q, limit: 1 }, force)
    switch (v.type) {
      case 'kanban':
        syncTotals(q, v)
        if (v.subGroupBy && v.subGroupBy !== v.groupBy && v.groupBy) {
          keep('swimlanes')
          swimlanes!.setQuery(q, v.groupBy, groupSpec(v.subGroupBy, v), force)
          swimlanes!.refresh()
          show(swimlanes!.el)
        } else {
          keep('kanban')
          kanban.setQuery(q, v.groupBy, force)
          kanban.refresh()
          show(kanban.el)
        }
        return
      case 'list':
      case 'gallery':
        keep('list')
        syncTotals(q, v)
        list!.setQuery(q, { kind: v.type, cover: v.cover || undefined, size: v.cardSize }, force)
        list!.refresh()
        show(list!.el)
        return
      case 'calendar':
        keep('calendar')
        syncTotals(q, v)
        calendar!.setQuery(q, v.dateBy, force)
        calendar!.refresh()
        show(calendar!.el)
        return
      case 'timeline':
        keep('timeline')
        syncTotals(q, v)
        timeline!.setQuery(q, { dateBy: v.dateBy, endBy: v.endBy, scale: v.scale, dependsOn: v.dependsOn || undefined }, force)
        timeline!.refresh()
        show(timeline!.el)
        return
      case 'chart': {
        keep('chart')
        syncTotals(q, v)
        const g = v.groupBy ? groupSpec(v.groupBy, v) : null
        chart!.setQuery(q, {
          key: v.groupBy, type: g?.type ?? 'text', field: g?.field ?? { prop: '' }, options: g?.options ?? [], dateGroup: g?.dateGroup,
          kind: v.chartKind, y: v.chartY, calc: v.chartCalc,
        }, force)
        show(chart!.el)
        return
      }
      case 'form':
        keep('form')
        syncTotals(q, v)
        form!.refresh()
        show(form!.el)
        return
    }
    if (v.groupBy && groupedTable) {
      keep('grouped')
      table.setQuery({ ...q, limit: 1 }, force)
      syncTotals(q, v)
      groupedTable.setQuery(q, groupSpec(v.groupBy, v), force)
      groupedTable.refresh()
      show(groupedTable.el)
    } else {
      keep('table')
      table.setQuery(q, force)
      syncTotals(q, v)
      table.refresh()
      show(table.el)
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
      bulk = h('div', { class: 'base-bulk', 'data-testid': 'base-bulk' })
      bulk.hidden = true
      const root = h('div', { class: embedded ? 'base-view base-view-embedded' : 'base-view', 'data-testid': 'base-view' }, toolbar, popover, bulk, h('div', { class: 'base-main' }, body, peekPanel.el), footer, card)
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
      // Modeles repetes : a l'ouverture, puis toutes les heures tant que la base est ouverte.
      const repeatTimer = setInterval(() => void runRepeats(), 3_600_000)
      unsubs.push(() => clearInterval(repeatTimer))
      setTimeout(() => void runRepeats(), 1500)
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
      groupedTable?.destroy()
      swimlanes?.destroy()
      list?.destroy()
      calendar?.destroy()
      timeline?.destroy()
      chart?.destroy()
      form?.destroy()
      related?.close()
      childStop?.()
      lightRows.close()
      if (activeBaseView === handle) activeBaseView = null
      container = null
    },
    addPage,
    addLightRow,
    exportCsv,
    importCsv,
  }
  return handle
}
