// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Vue tableau d'une base, a defilement virtualise : seules les lignes
// visibles existent dans la page, les donnees arrivent par pages
// (api.query, pagination par curseur). La premiere page est suivie en direct
// (watch) : une cellule changee par un autre membre se voit tout de suite.
import { AUTO_PROPERTY_TYPES } from '@savoire/plugin-api'
import type { CompiledFormula, IQueryEngine, PropertyType, PropertyValue, Query, QueryResult, QueryRow } from '@savoire/plugin-api'
import { h, openEditor, renderValue, type CellContext } from './cells'
import { TITLE_COLUMN } from './manifest'
import type { CellAnnotation } from './annotations'

export const ROW_HEIGHT = 32
/** Retour a la ligne : trois lignes de texte par cellule. */
export const WRAP_HEIGHT = 64
/** Colonne de selection (case, poignee de l'ordre manuel). */
const SELECT_WIDTH = 34
export const PAGE_SIZE = 200
const OVERSCAN = 8
/** Tableau integre (un groupe) : lignes montrees d'abord, puis par « Voir plus ». */
export const EMBEDDED_ROWS = 50

export interface TableOptions {
  /**
   * Dans une section (tableau groupe) : pas de defilement propre, toutes les
   * lignes montrees jusqu'a EMBEDDED_ROWS, puis « Voir plus ».
   */
  embedded?: boolean
}

export interface TableColumn {
  key: string
  label: string
  width: number
  type: PropertyType
  /** Colonne formule : calculee pour chaque ligne, jamais editee. */
  formula?: CompiledFormula
  /** Formule mal ecrite : le message, montre dans chaque cellule. */
  formulaError?: string
  /** Colonne calculee : type et propriete d'affichage du resultat (rollup), sinon devine. */
  resultType?: PropertyType
  resultKey?: string
  /** Colonne bouton : son libelle (un clic execute ses actions). */
  button?: { label: string }
}

/** Profondeur maximale des sous-elements affiches. */
const MAX_DEPTH = 4

/** Type d'affichage d'un resultat de formule. */
function resultType(v: PropertyValue): PropertyType {
  if (typeof v === 'number') return 'number'
  if (typeof v === 'boolean') return 'checkbox'
  if (Array.isArray(v)) return 'multiselect'
  return 'text'
}

export interface TableHost {
  engine: IQueryEngine
  readOnly(): boolean
  columns(): TableColumn[]
  cells(): CellContext
  /** Nouvelle valeur d'une cellule (ligne-page : frontmatter ; ligne legere : lot). */
  edit(row: QueryRow, key: string, value: PropertyValue): void
  rename(row: QueryRow, title: string): void
  open(row: QueryRow): void
  promote(row: QueryRow): void
  remove(row: QueryRow): void
  columnMenu(key: string, anchor: HTMLElement): void
  resize(key: string, width: number): void
  addColumn(anchor: HTMLElement): void
  /** Chaque resultat suivi (lignes vues, total) : pour les colonnes decouvertes et le compteur. */
  onResult(result: QueryResult): void
  /** Texte du total de chaque colonne qui en a un (« Somme 42 ») ; absent : pas de pied. */
  totals?(): Map<string, string>
  /** Choisir le total d'une colonne. */
  totalMenu?(key: string, anchor: HTMLElement): void
  /** « + Nouvelle page » sous la derniere ligne, comme dans Notion ; absent : pas de bouton. */
  addRow?(): void
  /** Change quand des valeurs calculees ailleurs changent (rollups) : les lignes se redessinent. */
  revision?(): unknown
  /** Revision : ce qui vise une cellule (commentaires, valeurs proposees). */
  annotation?(row: QueryRow, key: string): CellAnnotation | null
  /** Signature de ce qui vise une ligne : elle se redessine quand elle change. */
  annotationSig?(row: QueryRow): string
  /** Ouvre les fils d'une cellule, pres de `anchor`. */
  openAnnotations?(ids: string[], anchor: HTMLElement): void
  /** Commenter une cellule (clic droit) ; absent : pas de commentaire. */
  commentCell?(row: QueryRow, key: string, anchor: HTMLElement): void
  /** Accepter ou refuser une valeur proposee, depuis la cellule ; absent : pas de boutons. */
  decide?(id: string, accept: boolean): void
  /** Deplace une colonne avant une autre (glisser son en-tete). */
  moveColumn?(key: string, before: string): void
  /** Colonnes figees a gauche (le nom compte pour une) ; 0 : aucune. */
  frozen?(): number
  /** Retour a la ligne dans les cellules (lignes plus hautes). */
  wrap?(): boolean
  /** Selection de lignes : absent, pas de cases ; appele a chaque changement. */
  selectionChanged?(rows: QueryRow[]): void
  /** Apercu lateral d'une ligne. */
  peek?(row: QueryRow): void
  /** Ordre manuel : poignee pour glisser une ligne avant une autre (null : a la fin). */
  canReorder?(): boolean
  reorder?(id: string, before: string | null, order: string[]): void
  /** Colle des textes dans des cellules (copier-coller depuis un tableur). */
  paste?(cells: { row: QueryRow; key: string; text: string }[]): void
  /** Sous-elements : la requete des enfants d'une ligne ; absent : pas de sous-elements. */
  childQuery?(row: QueryRow): Query | null
  /** Nombre d'enfants d'une ligne (pour la fleche). */
  childCount?(row: QueryRow): number
  /** Ajoute un sous-element a une ligne. */
  addChild?(row: QueryRow): void
  /** Un bouton d'une colonne, pour une ligne. */
  runButton?(row: QueryRow, key: string): void
  /** Structure verrouillee : largeurs, ordre et ajout de colonnes figes. */
  locked?(): boolean
}

export class BaseTable {
  readonly el: HTMLElement
  private readonly head: HTMLElement
  private readonly body: HTMLElement
  private readonly foot: HTMLElement
  private readonly adder: HTMLElement
  private readonly more: HTMLElement
  private readonly embedded: boolean
  private shown = EMBEDDED_ROWS
  private query: Query | null = null
  private stopWatch: (() => void) | null = null
  private pages = new Map<number, QueryRow[]>()
  private cursors = new Map<number, string | undefined>()
  private fetching = new Set<number>()
  private generation = 0
  private total = 0
  private frame: number | null = null
  private editing = false
  /** Lignes deja dessinees, par contenu : une mise a jour de l'index ne recree que ce qui a change. */
  private drawn = new Map<string, { sig: string; el: HTMLElement }>()
  /** Lignes cochees (ids). */
  private selected = new Set<string>()
  /** Lignes depliees (sous-elements) : leurs enfants, suivis en direct. */
  private expanded = new Map<string, { rows: QueryRow[]; stop: () => void }>()

  constructor(private readonly host: TableHost, opts: TableOptions = {}) {
    this.embedded = !!opts.embedded
    this.head = h('div', { class: 'base-thead', 'data-testid': 'base-thead' })
    this.body = h('div', { class: 'base-tbody', 'data-testid': 'base-tbody' })
    this.foot = h('div', { class: 'base-tfoot', 'data-testid': 'base-tfoot' })
    // Ajouter une ligne en etant a la fin du tableau, sans remonter a la barre.
    this.adder = h('button', { class: 'base-tadd', type: 'button', 'data-testid': 'base-add-row-bottom' }, '+ Nouvelle page')
    this.adder.addEventListener('click', () => this.host.addRow?.())
    this.more = h('button', { class: 'base-tadd base-tmore', type: 'button', 'data-testid': 'base-table-more' })
    this.more.hidden = true
    this.more.addEventListener('click', () => { this.shown += EMBEDDED_ROWS; this.renderRows(true) })
    this.el = h('div', { class: this.embedded ? 'base-table base-table-embedded' : 'base-table', 'data-testid': 'base-table' },
      this.head, this.body, this.more, this.adder, this.foot)
    if (!this.embedded) this.el.addEventListener('scroll', () => this.schedule())
    this.el.addEventListener('keydown', e => this.onKey(e))
    this.el.addEventListener('copy', e => this.onCopy(e))
    this.el.addEventListener('paste', e => this.onPaste(e))
  }

  private get rowHeight(): number {
    return this.host.wrap?.() ? WRAP_HEIGHT : ROW_HEIGHT
  }

  private get selectable(): boolean {
    return !!this.host.selectionChanged
  }

  /** Ligne de premier niveau a la position `i` (si elle est chargee). */
  private topAt(i: number): QueryRow | undefined {
    const page = Math.floor(i / PAGE_SIZE)
    return this.pages.get(page)?.[i - page * PAGE_SIZE]
  }

  /** Ligne affichee a la position `i` (sous-elements compris). */
  rowAt(i: number): QueryRow | undefined {
    return this.displayAt(i).row
  }

  // ── Sous-elements ────────────────────────────────────────────────────────

  /** Deplie ou replie les enfants d'une ligne. */
  toggleChildren(row: QueryRow): void {
    const open = this.expanded.get(row.id)
    if (open) {
      open.stop()
      this.expanded.delete(row.id)
      this.renderRows(true)
      return
    }
    const q = this.host.childQuery?.(row)
    if (!q) return
    const entry = { rows: [] as QueryRow[], stop: () => {} }
    this.expanded.set(row.id, entry)
    entry.stop = this.host.engine.watch({ ...q, limit: PAGE_SIZE }, r => {
      entry.rows = r.rows
      this.renderRows(true)
    })
    this.renderRows(true)
  }

  private closeChildren(): void {
    for (const e of this.expanded.values()) e.stop()
    this.expanded.clear()
  }

  /** Les enfants depliees d'une ligne, a plat, avec leur profondeur. */
  private flatChildren(id: string, depth: number, seen: Set<string>): { row: QueryRow; depth: number }[] {
    const e = this.expanded.get(id)
    if (!e || depth > MAX_DEPTH) return []
    const out: { row: QueryRow; depth: number }[] = []
    for (const r of e.rows) {
      if (seen.has(r.id)) continue
      seen.add(r.id)
      out.push({ row: r, depth })
      out.push(...this.flatChildren(r.id, depth + 1, seen))
    }
    return out
  }

  /** Lignes de premier niveau depliees (chargees), par position, et leurs enfants a plat. */
  private insertions(): { at: number; kids: { row: QueryRow; depth: number }[] }[] {
    if (!this.expanded.size) return []
    const out: { at: number; kids: { row: QueryRow; depth: number }[] }[] = []
    for (const [k, rows] of this.pages) {
      rows.forEach((r, j) => {
        if (!this.expanded.has(r.id)) return
        const kids = this.flatChildren(r.id, 1, new Set([r.id]))
        if (kids.length) out.push({ at: k * PAGE_SIZE + j, kids })
      })
    }
    return out.sort((a, b) => a.at - b.at)
  }

  /** Nombre de lignes affichees (sous-elements compris). */
  private displayCount(): number {
    return this.total + this.insertions().reduce((n, x) => n + x.kids.length, 0)
  }

  /** Ce qu'il y a a la position affichee `d` : une ligne (et sa profondeur), ou la position d'une ligne a charger. */
  private displayAt(d: number): { row?: QueryRow; depth: number; top: number } {
    let shift = 0
    for (const ins of this.insertions()) {
      if (d <= ins.at + shift) break
      const k = d - (ins.at + shift) - 1
      if (k < ins.kids.length) return { row: ins.kids[k].row, depth: ins.kids[k].depth, top: ins.at }
      shift += ins.kids.length
    }
    const top = d - shift
    return { row: this.topAt(top), depth: 0, top }
  }

  /** Lignes cochees, parmi celles chargees. */
  selectedRows(): QueryRow[] {
    return this.loadedRows().filter(r => this.selected.has(r.id))
  }

  clearSelection(): void {
    if (!this.selected.size) return
    this.selected.clear()
    this.drawn.clear()
    this.host.selectionChanged?.([])
    this.renderRows(true)
    this.renderHead()
  }

  private setSelected(id: string, on: boolean): void {
    if (on) this.selected.add(id)
    else this.selected.delete(id)
    this.host.selectionChanged?.(this.selectedRows())
  }

  /** Decalage a gauche de chaque colonne figee (position collante). */
  private stickyLefts(cols: TableColumn[]): Map<string, number> {
    const out = new Map<string, number>()
    const n = this.host.frozen?.() ?? 0
    let left = this.selectable ? SELECT_WIDTH : 0
    for (let i = 0; i < Math.min(n, cols.length); i++) {
      out.set(cols[i].key, left)
      left += cols[i].width
    }
    return out
  }

  private stick(el: HTMLElement, left: number | undefined, last: boolean): void {
    if (left === undefined) return
    el.classList.add('base-sticky')
    if (last) el.classList.add('base-sticky-last')
    el.style.left = `${left}px`
  }

  // ── Clavier, copier, coller ──────────────────────────────────────────────

  private cellOf(target: EventTarget | null): HTMLElement | null {
    const el = target as HTMLElement | null
    return el?.closest?.('.base-td[data-key]') as HTMLElement | null
  }

  private position(td: HTMLElement): { index: number; key: string } | null {
    const tr = td.closest('.base-tr') as HTMLElement | null
    const index = Number(tr?.dataset.index)
    return tr && Number.isInteger(index) ? { index, key: td.dataset.key ?? '' } : null
  }

  private focusCell(index: number, key: string): void {
    const top = index * this.rowHeight
    if (!this.embedded) {
      if (top < this.el.scrollTop + 32) this.el.scrollTop = Math.max(0, top - 32)
      else if (top + this.rowHeight > this.el.scrollTop + this.el.clientHeight) this.el.scrollTop = top + this.rowHeight - this.el.clientHeight + 4
      this.renderRows(true)
    }
    const td = this.body.querySelector(`.base-tr[data-index="${index}"] .base-td[data-key="${key.replace(/["\\]/g, '\\$&')}"]`) as HTMLElement | null
    td?.focus()
  }

  private onKey(e: KeyboardEvent): void {
    const td = this.cellOf(e.target)
    if (!td || this.editing || e.target !== td) return
    const pos = this.position(td)
    if (!pos) return
    const keys = this.host.columns().map(c => c.key)
    const col = keys.indexOf(pos.key)
    const max = (this.embedded ? Math.min(this.displayCount(), this.shown) : this.displayCount()) - 1
    let next: { index: number; key: string } | null = null
    switch (e.key) {
      case 'ArrowDown': next = { index: Math.min(max, pos.index + 1), key: pos.key }; break
      case 'ArrowUp': next = { index: Math.max(0, pos.index - 1), key: pos.key }; break
      case 'ArrowRight': case 'Tab': next = { index: pos.index, key: keys[Math.min(keys.length - 1, col + (e.shiftKey && e.key === 'Tab' ? -1 : 1))] }; break
      case 'ArrowLeft': next = { index: pos.index, key: keys[Math.max(0, col - 1)] }; break
      case 'Delete':
      case 'Backspace': {
        const row = this.rowAt(pos.index)
        const c = this.host.columns().find(x => x.key === pos.key)
        if (row && c && !this.host.readOnly() && c.key !== TITLE_COLUMN && !c.formula && !c.formulaError && !AUTO_PROPERTY_TYPES.includes(c.type)) {
          e.preventDefault()
          this.host.edit(row, c.key, null)
        }
        return
      }
      case 'Escape': if (this.selected.size) { e.preventDefault(); this.clearSelection() } return
      default: return
    }
    e.preventDefault()
    e.stopPropagation()
    if (next) this.focusCell(next.index, next.key)
  }

  /** Texte d'une cellule, pour le presse-papiers. */
  private cellText(row: QueryRow, col: TableColumn): string {
    if (col.key === TITLE_COLUMN) return row.title
    const v = col.formula ? (r => r.ok ? r.value : null)(col.formula.evaluate(row)) : row.values[col.key]
    if (v === null || v === undefined) return ''
    return Array.isArray(v) ? v.join(', ') : typeof v === 'boolean' ? (v ? 'true' : 'false') : String(v)
  }

  private onCopy(e: ClipboardEvent): void {
    if (this.editing) return
    const cols = this.host.columns()
    let text: string | null = null
    const rows = this.selectedRows()
    if (rows.length) {
      // Lignes cochees : un tableau (tabulations), comme un tableur.
      text = [cols.map(c => c.label).join('\t'), ...rows.map(r => cols.map(c => this.cellText(r, c).replace(/[\t\n]/g, ' ')).join('\t'))].join('\n')
    } else {
      const td = this.cellOf(document.activeElement)
      const pos = td && this.position(td)
      const row = pos ? this.rowAt(pos.index) : undefined
      const col = pos ? cols.find(c => c.key === pos.key) : undefined
      if (row && col) text = this.cellText(row, col)
    }
    if (text === null || !e.clipboardData) return
    e.clipboardData.setData('text/plain', text)
    e.preventDefault()
  }

  private onPaste(e: ClipboardEvent): void {
    if (this.editing || this.host.readOnly() || !this.host.paste) return
    const td = this.cellOf(document.activeElement)
    const pos = td && this.position(td)
    const text = e.clipboardData?.getData('text/plain')
    if (!pos || text === undefined) return
    e.preventDefault()
    const keys = this.host.columns().map(c => c.key)
    const start = keys.indexOf(pos.key)
    const lines = text.replace(/\r\n?/g, '\n').replace(/\n$/, '').split('\n')
    const cells: { row: QueryRow; key: string; text: string }[] = []
    lines.forEach((line, i) => {
      const row = this.rowAt(pos.index + i)
      if (!row) return
      line.split('\t').forEach((t, j) => {
        const key = keys[start + j]
        if (key) cells.push({ row, key, text: t })
      })
    })
    if (cells.length) this.host.paste(cells)
  }

  /**
   * Change de requete (filtres, tris, source) : on repart de la premiere page.
   * `force` : meme requete, mais ses formules ont change.
   */
  setQuery(query: Query, force = false): void {
    const same = this.query && JSON.stringify(this.query) === JSON.stringify(query)
    if (same && !force) return
    this.query = query
    this.stopWatch?.()
    this.closeChildren()
    this.reset()
    this.stopWatch = this.host.engine.watch({ ...query, limit: PAGE_SIZE }, r => this.onFirstPage(r))
  }

  /** Les colonnes ou les types ont change : redessiner. */
  refresh(): void {
    this.renderHead()
    this.renderRows(true)
    this.renderFoot()
  }

  /** Pied du tableau : le total de chaque colonne, ou « Calculer » au survol. */
  renderFoot(): void {
    this.adder.hidden = !this.host.addRow || this.host.readOnly()
    this.adder.style.width = `${this.width()}px`
    const totals = this.host.totals?.()
    const ro = this.host.readOnly()
    if (!totals || (ro && totals.size === 0)) { this.foot.hidden = true; return }
    this.foot.hidden = false
    const cells = this.host.columns().map(col => {
      const text = totals.get(col.key)
      const td = h('button', {
        class: text ? 'base-tf base-tf-set' : 'base-tf', type: 'button', 'data-key': col.key, 'data-testid': 'base-total',
      }, text ?? (col.key === TITLE_COLUMN ? '' : 'Calculer'))
      td.style.width = `${col.width}px`
      if (ro || col.key === TITLE_COLUMN) td.setAttribute('disabled', '')
      else td.addEventListener('click', () => this.host.totalMenu?.(col.key, td))
      return td
    })
    this.foot.replaceChildren(...cells)
    this.foot.style.width = `${this.width()}px`
  }

  destroy(): void {
    this.stopWatch?.()
    this.stopWatch = null
    this.closeChildren()
    if (this.frame !== null) cancelAnimationFrame(this.frame)
  }

  /** Lignes chargees (pour les tests et le kanban). */
  loadedRows(): QueryRow[] {
    return [...this.pages.entries()].sort((a, b) => a[0] - b[0]).flatMap(([, rows]) => rows)
  }

  get rowCount(): number {
    return this.total
  }

  private reset(): void {
    this.generation++
    this.pages = new Map()
    this.cursors = new Map()
    this.fetching = new Set()
    this.total = 0
  }

  private onFirstPage(result: QueryResult): void {
    // Toute modification de l'index relance la premiere page : les pages
    // suivantes sont redemandees a la volee.
    this.reset()
    this.pages.set(0, result.rows)
    this.cursors.set(1, result.next)
    this.total = result.total
    this.host.onResult(result)
    this.refresh()
  }

  private ensurePage(k: number): void {
    if (this.pages.has(k) || this.fetching.has(k) || !this.query) return
    if (!this.cursors.has(k)) {
      if (k > 0) this.ensurePage(k - 1)
      return
    }
    const cursor = this.cursors.get(k)
    if (!cursor) return
    const gen = this.generation
    this.fetching.add(k)
    void this.host.engine.query({ ...this.query, limit: PAGE_SIZE, cursor }).then(r => {
      if (gen !== this.generation) return
      this.fetching.delete(k)
      this.pages.set(k, r.rows)
      this.cursors.set(k + 1, r.next)
      this.schedule()
    }, err => {
      if (gen !== this.generation) return
      this.fetching.delete(k)
      console.warn('[plugin-base] page non chargee', err)
    })
  }

  private schedule(): void {
    if (this.frame !== null) return
    const raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : (cb: FrameRequestCallback) => setTimeout(() => cb(0), 16) as unknown as number
    this.frame = raf(() => {
      this.frame = null
      this.renderRows(false)
    })
  }

  private width(): number {
    return this.host.columns().reduce((n, c) => n + c.width, 0) + 40 + (this.selectable ? SELECT_WIDTH : 0)
  }

  private renderHead(): void {
    const cols = this.host.columns()
    const lefts = this.stickyLefts(cols)
    const lastFrozen = [...lefts.keys()].pop()
    const cells = cols.map(col => {
      const th = h('div', { class: 'base-th', 'data-key': col.key, 'data-testid': 'base-th', title: col.label })
      th.style.width = `${col.width}px`
      this.stick(th, lefts.get(col.key), col.key === lastFrozen)
      // Glisser un en-tete sur un autre : la colonne passe devant (le nom reste premier).
      const frozenHead = this.host.readOnly() || !!this.host.locked?.()
      if (this.host.moveColumn && !frozenHead && col.key !== TITLE_COLUMN) {
        th.draggable = true
        th.addEventListener('dragstart', e => { e.dataTransfer?.setData('text/x-base-col', col.key); if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move' })
      }
      if (this.host.moveColumn && !frozenHead) {
        th.addEventListener('dragover', e => { if (e.dataTransfer?.types?.includes('text/x-base-col')) { e.preventDefault(); th.classList.add('base-th-over') } })
        th.addEventListener('dragleave', () => th.classList.remove('base-th-over'))
        th.addEventListener('drop', e => {
          th.classList.remove('base-th-over')
          const from = e.dataTransfer?.getData('text/x-base-col')
          if (!from || from === col.key) return
          e.preventDefault()
          // Deposer sur le nom : juste apres lui.
          const target = col.key === TITLE_COLUMN ? cols[1]?.key : col.key
          if (target && target !== from) this.host.moveColumn!(from, target)
        })
      }
      const label = h('button', { class: 'base-th-label', type: 'button' }, col.label)
      label.addEventListener('click', () => this.host.columnMenu(col.key, th))
      th.append(label)
      if (!frozenHead) {
        const grip = h('span', { class: 'base-th-grip', title: 'Largeur' })
        grip.addEventListener('mousedown', e => this.startResize(e, col, th))
        th.append(grip)
      }
      return th
    })
    const add = h('button', { class: 'base-th-add', type: 'button', title: 'Ajouter une colonne', 'data-testid': 'base-add-column' }, '+')
    add.disabled = this.host.readOnly() || !!this.host.locked?.()
    add.addEventListener('click', () => this.host.addColumn(add))
    const lead: HTMLElement[] = []
    if (this.selectable) {
      const all = h('input', { type: 'checkbox', title: 'Tout cocher', 'data-testid': 'base-select-all' })
      const loaded = this.loadedRows()
      all.checked = loaded.length > 0 && loaded.every(r => this.selected.has(r.id))
      all.addEventListener('change', () => {
        for (const r of loaded) { if (all.checked) this.selected.add(r.id); else this.selected.delete(r.id) }
        this.host.selectionChanged?.(this.selectedRows())
        this.renderRows(true)
      })
      const box = h('div', { class: 'base-th base-th-select' }, all)
      box.style.width = `${SELECT_WIDTH}px`
      this.stick(box, (this.host.frozen?.() ?? 0) > 0 ? 0 : undefined, false)
      lead.push(box)
    }
    this.head.replaceChildren(...lead, ...cells, add)
    this.head.style.width = `${this.width()}px`
  }

  private startResize(e: MouseEvent, col: TableColumn, th: HTMLElement): void {
    e.preventDefault()
    e.stopPropagation()
    const start = e.clientX
    const initial = col.width
    let width = initial
    const move = (ev: MouseEvent) => {
      width = Math.max(60, initial + ev.clientX - start)
      th.style.width = `${width}px`
    }
    const up = () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
      if (width !== initial) this.host.resize(col.key, width)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }

  private renderRows(force: boolean): void {
    if (this.editing && !force) return
    // Integre : toutes les lignes montrees (« Voir plus » en ajoute) ; sinon la fenetre visible.
    const all = this.displayCount()
    const count = this.embedded ? Math.min(all, this.shown) : all
    const viewport = this.el.clientHeight || 600
    const top = this.embedded ? 0 : this.el.scrollTop
    const rh = this.rowHeight
    const first = this.embedded ? 0 : Math.max(0, Math.floor(top / rh) - OVERSCAN)
    const last = this.embedded ? count - 1 : Math.min(all - 1, Math.ceil((top + viewport) / rh) + OVERSCAN)
    if (this.embedded) {
      this.more.hidden = all <= this.shown
      this.more.textContent = `Voir plus (${all - this.shown} de plus)`
      this.more.style.width = `${this.width()}px`
    }
    this.body.style.height = `${count * rh}px`
    this.body.style.width = `${this.width()}px`
    const cols = this.host.columns()
    const ctx = this.host.cells()
    // Les reglages des proprietes (couleurs, format) changent l'affichage des cellules.
    const colSig = JSON.stringify([cols, this.host.readOnly(), ctx.members.length, cols.map(c => ctx.def?.(c.key) ?? null), this.host.revision?.() ?? 0,
      this.host.frozen?.() ?? 0, rh, this.host.canReorder?.() ?? false])
    const rows: HTMLElement[] = []
    const kept = new Map<string, { sig: string; el: HTMLElement }>()
    for (let i = first; i <= last; i++) {
      const at = this.displayAt(i)
      const row = at.row
      if (!row) {
        this.ensurePage(Math.floor(at.top / PAGE_SIZE))
        const ph = h('div', { class: 'base-tr base-tr-loading' }, '…')
        ph.style.top = `${i * rh}px`
        rows.push(ph)
        continue
      }
      // Meme contenu : meme element (un double-clic n'est pas perdu quand l'index bouge).
      const sig = JSON.stringify([row.title, row.path, row.values, this.host.annotationSig?.(row) ?? '', this.selected.has(row.id),
        at.depth, this.expanded.has(row.id), this.host.childCount?.(row) ?? 0]) + colSig
      const prev = this.drawn.get(row.id)
      const el = prev && prev.sig === sig ? prev.el : this.renderRow(row, i, cols, at.depth)
      el.style.top = `${i * rh}px`
      el.dataset.index = String(i)
      kept.set(row.id, { sig, el })
      rows.push(el)
    }
    this.drawn = kept
    if (this.editing) {
      // Une cellule en edition reste en place (une valeur distante ne la coupe pas).
      const active = this.body.querySelector('.base-td-editing')?.closest('.base-tr') as HTMLElement | null
      if (active) {
        const idx = rows.findIndex(r => r.dataset.id === active.dataset.id)
        if (idx >= 0) rows[idx] = active
      }
    }
    // Rien ne bouge si les memes elements sont deja en place.
    const current = this.body.children
    const same = current.length === rows.length && rows.every((r, i) => current[i] === r)
    if (!same) this.body.replaceChildren(...rows)
  }

  private renderRow(row: QueryRow, index: number, cols: TableColumn[], depth = 0): HTMLElement {
    const light = row.path === ''
    const tr = h('div', { class: light ? 'base-tr base-tr-light' : 'base-tr', 'data-testid': 'base-row', 'data-id': row.id, 'data-index': String(index) })
    const rh = this.rowHeight
    tr.style.top = `${index * rh}px`
    tr.style.height = `${rh}px`
    if (rh !== ROW_HEIGHT) tr.classList.add('base-tr-wrap')
    if (this.selected.has(row.id)) tr.classList.add('base-tr-selected')
    const ctx = this.host.cells()
    const ro = this.host.readOnly()
    const lefts = this.stickyLefts(cols)
    const lastFrozen = [...lefts.keys()].pop()
    if (this.selectable) {
      const box = h('input', { type: 'checkbox', title: 'Cocher la ligne', 'data-testid': 'base-select' })
      box.checked = this.selected.has(row.id)
      box.addEventListener('change', () => {
        this.setSelected(row.id, box.checked)
        tr.classList.toggle('base-tr-selected', box.checked)
        // L'element dessine ne correspond plus a son empreinte : il sera refait au prochain dessin.
        this.drawn.delete(row.id)
        this.renderHead()
      })
      const cell = h('div', { class: 'base-td base-td-select' }, box)
      cell.style.width = `${SELECT_WIDTH}px`
      this.stick(cell, (this.host.frozen?.() ?? 0) > 0 ? 0 : undefined, false)
      // Ordre manuel : la poignee se glisse sur une autre ligne.
      if (!ro && this.host.canReorder?.()) {
        const grip = h('span', { class: 'base-row-grip', title: 'Glisser pour déplacer', draggable: 'true', 'data-testid': 'base-row-grip' }, '⋮⋮')
        grip.addEventListener('dragstart', e => { e.dataTransfer?.setData('text/x-base-order', row.id); if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move' })
        cell.prepend(grip)
        tr.addEventListener('dragover', e => { if (e.dataTransfer?.types?.includes('text/x-base-order')) { e.preventDefault(); tr.classList.add('base-tr-over') } })
        tr.addEventListener('dragleave', () => tr.classList.remove('base-tr-over'))
        tr.addEventListener('drop', e => {
          tr.classList.remove('base-tr-over')
          const id = e.dataTransfer?.getData('text/x-base-order')
          if (!id || id === row.id) return
          e.preventDefault()
          this.host.reorder?.(id, row.id, this.loadedRows().map(r => r.id))
        })
      }
      tr.append(cell)
    }
    for (const col of cols) {
      const td = h('div', { class: 'base-td', 'data-key': col.key, tabindex: '-1' })
      td.style.width = `${col.width}px`
      this.stick(td, lefts.get(col.key), col.key === lastFrozen)
      td.addEventListener('mousedown', ev => { if (ev.target === td) setTimeout(() => { if (!this.editing) td.focus() }, 0) })
      if (col.key === TITLE_COLUMN) {
        td.classList.add('base-td-title')
        const name = light
          ? h('span', { class: 'base-title', 'data-testid': 'base-title' }, row.title || 'Sans titre')
          : h('a', { class: 'base-title base-title-page', href: '#', 'data-testid': 'base-title' }, row.title || 'Sans titre')
        if (!light) name.addEventListener('click', e => { e.preventDefault(); this.host.open(row) })
        // Sous-elements : retrait selon la profondeur, fleche pour deplier.
        if (this.host.childQuery) {
          if (depth) td.style.paddingLeft = `${8 + depth * 18}px`
          const count = this.host.childCount?.(row) ?? 0
          const open = this.expanded.has(row.id)
          const toggle = h('button', { class: 'base-sub-toggle', type: 'button', title: open ? 'Replier' : 'Déplier les sous-éléments', 'data-testid': 'base-sub-toggle' }, open ? '▾' : '▸')
          toggle.style.visibility = count || open ? 'visible' : 'hidden'
          toggle.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); this.toggleChildren(row) })
          td.append(toggle)
        }
        td.append(h('span', { class: 'base-kind', title: light ? 'Ligne légère' : 'Page' }, light ? '·' : '📄'), name)
        if (!ro && light) {
          const promote = h('button', { class: 'base-row-action', type: 'button', title: 'Promouvoir en page', 'data-testid': 'base-promote' }, '⇪')
          promote.addEventListener('click', e => { e.stopPropagation(); this.host.promote(row) })
          const remove = h('button', { class: 'base-row-action', type: 'button', title: 'Supprimer la ligne', 'data-testid': 'base-remove' }, '×')
          remove.addEventListener('click', e => { e.stopPropagation(); this.host.remove(row) })
          td.append(promote, remove)
        }
        if (this.host.addChild && !ro && !light) {
          const child = h('button', { class: 'base-row-action', type: 'button', title: 'Ajouter un sous-élément', 'data-testid': 'base-add-child' }, '+')
          child.addEventListener('click', e => {
            e.preventDefault()
            e.stopPropagation()
            this.host.addChild!(row)
            // Les enfants se voient tout de suite.
            if (!this.expanded.has(row.id)) this.toggleChildren(row)
          })
          td.append(child)
        }
        if (this.host.peek) {
          const peek = h('button', { class: 'base-row-action base-row-peek', type: 'button', title: 'Aperçu', 'data-testid': 'base-peek' }, '⤢')
          peek.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); this.host.peek!(row) })
          td.append(peek)
        }
        if (!ro) td.addEventListener('dblclick', () => this.editCell(td, col, row.title, v => this.host.rename(row, String(v ?? '').trim() || 'Sans titre')))
      } else if (col.button) {
        td.classList.add('base-td-button')
        const b = h('button', { class: 'base-btn base-cell-button', type: 'button', 'data-testid': 'base-cell-button' }, col.button.label)
        b.disabled = ro
        b.addEventListener('click', e => { e.stopPropagation(); this.host.runButton?.(row, col.key) })
        td.append(b)
      } else if (col.formula || col.formulaError) {
        td.classList.add('base-td-formula')
        const r = col.formula ? col.formula.evaluate(row) : { ok: false as const, error: col.formulaError! }
        if (r.ok) td.append(renderValue(col.resultType ?? resultType(r.value), r.value, ctx, col.resultKey))
        else {
          td.classList.add('base-td-error')
          td.title = r.error
          td.append(h('span', { class: 'base-formula-error' }, '⚠'))
        }
      } else {
        const value = row.values[col.key]
        td.append(renderValue(col.type, value, ctx, col.key))
        if (!ro && !AUTO_PROPERTY_TYPES.includes(col.type)) {
          if (col.type === 'checkbox') {
            td.classList.add('base-td-check')
            td.addEventListener('click', () => this.host.edit(row, col.key, !(value === true || value === 'true')))
          } else {
            td.addEventListener('dblclick', () => this.editCell(td, col, value, v => this.host.edit(row, col.key, v)))
            td.addEventListener('keydown', e => { if (e.key === 'Enter') this.editCell(td, col, value, v => this.host.edit(row, col.key, v)) })
          }
        }
      }
      this.markAnnotations(td, row, col)
      tr.append(td)
    }
    return tr
  }

  /**
   * Revision : une valeur proposee se lit dans la cellule (l'ancienne barree,
   * la nouvelle a cote) et s'accepte ou se refuse sur place ; un commentaire
   * met une marque. Clic sur la proposition ou la marque : le fil ; clic
   * droit : commenter la cellule.
   */
  private markAnnotations(td: HTMLElement, row: QueryRow, col: TableColumn): void {
    const key = col.key
    if (this.host.commentCell) {
      td.addEventListener('contextmenu', e => {
        e.preventDefault()
        this.host.commentCell!(row, key, td)
      })
    }
    const a = this.host.annotation?.(row, key)
    if (!a || a.ids.length === 0) return
    const quiet = (node: HTMLElement) => {
      node.addEventListener('mousedown', e => e.stopPropagation())
      node.addEventListener('dblclick', e => e.stopPropagation())
    }
    const open = (node: HTMLElement) => {
      quiet(node)
      node.addEventListener('click', e => { e.stopPropagation(); this.host.openAnnotations?.(a.ids, td) })
    }
    if (a.proposals.length) {
      td.classList.add('base-td-proposed')
      const value = a.proposals[a.proposals.length - 1]
      const id = a.proposalIds[a.proposalIds.length - 1]
      // L'ancienne valeur, barree : le nom de la ligne, ou tout le contenu de la cellule.
      const title = key === TITLE_COLUMN ? td.querySelector<HTMLElement>('.base-title') : null
      let before: HTMLElement
      if (title) { title.classList.add('base-td-before'); before = title }
      else {
        before = h('span', { class: 'base-td-before' })
        before.append(...Array.from(td.childNodes))
        td.append(before)
      }
      const shown = value === null || value === '' || (Array.isArray(value) && value.length === 0)
        ? h('i', { class: 'base-td-empty' }, 'vide')
        : key === TITLE_COLUMN ? document.createTextNode(String(value)) : renderValue(col.type, value, this.host.cells(), col.key)
      const after = h('span', {
        class: 'base-td-after', 'data-testid': 'base-cell-proposal',
        title: a.proposals.length > 1 ? `${a.proposals.length} valeurs proposées : cliquer pour les voir` : 'Valeur proposée : cliquer pour le fil',
      }, shown)
      open(after)
      before.after(after)
      if (this.host.decide && !this.host.readOnly()) {
        const decide = (accept: boolean) => {
          const b = h('button', {
            class: accept ? 'base-td-decide base-td-accept' : 'base-td-decide', type: 'button',
            'data-testid': accept ? 'base-cell-accept' : 'base-cell-reject',
            title: accept ? 'Accepter la valeur proposée' : 'Refuser la valeur proposée',
          }, accept ? '✓' : '✕')
          quiet(b)
          b.addEventListener('click', e => { e.stopPropagation(); this.host.decide!(id, accept) })
          return b
        }
        const box = h('span', { class: 'base-td-decision' }, decide(true), decide(false))
        after.after(box)
      }
    }
    // Commentaires, ou plusieurs fils : une marque qui les ouvre.
    if (!a.proposals.length) td.classList.add('base-td-annotated')
    if (a.comments === 0 && a.ids.length === 1) return
    const parts: string[] = []
    if (a.comments) parts.push(`${a.comments} commentaire${a.comments > 1 ? 's' : ''}`)
    if (a.proposals.length) parts.push(`${a.proposals.length} proposition${a.proposals.length > 1 ? 's' : ''}`)
    const badge = h('button', {
      class: 'base-td-note', type: 'button', 'data-testid': 'base-cell-annotation', title: parts.join(', '),
    }, a.comments ? '💬' : '✎')
    if (a.ids.length > 1) badge.append(h('span', { class: 'base-td-note-count' }, String(a.ids.length)))
    open(badge)
    td.append(badge)
  }

  private editCell(td: HTMLElement, col: TableColumn, value: PropertyValue | undefined, commit: (v: PropertyValue) => void): void {
    if (this.editing) return
    this.editing = true
    td.classList.add('base-td-editing')
    const type: PropertyType = col.key === TITLE_COLUMN ? 'text' : col.type
    const end = () => {
      this.editing = false
      td.classList.remove('base-td-editing')
      this.renderRows(true)
    }
    openEditor(td, col.key, type, value ?? null, this.host.cells(), v => {
      end()
      const before = JSON.stringify(value ?? null)
      if (JSON.stringify(v) !== before) commit(v)
    }, end)
  }
}
