// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Vue tableau d'une base, a defilement virtualise : seules les lignes
// visibles existent dans la page, les donnees arrivent par pages
// (api.query, pagination par curseur). La premiere page est suivie en direct
// (watch) : une cellule changee par un autre membre se voit tout de suite.
import type { IQueryEngine, PropertyType, PropertyValue, Query, QueryResult, QueryRow } from '@savoire/plugin-api'
import { h, openEditor, renderValue, type CellContext } from './cells'
import { TITLE_COLUMN } from './manifest'

export const ROW_HEIGHT = 32
export const PAGE_SIZE = 200
const OVERSCAN = 8

export interface TableColumn {
  key: string
  label: string
  width: number
  type: PropertyType
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
}

export class BaseTable {
  readonly el: HTMLElement
  private readonly head: HTMLElement
  private readonly body: HTMLElement
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

  constructor(private readonly host: TableHost) {
    this.head = h('div', { class: 'base-thead', 'data-testid': 'base-thead' })
    this.body = h('div', { class: 'base-tbody', 'data-testid': 'base-tbody' })
    this.el = h('div', { class: 'base-table', 'data-testid': 'base-table' }, this.head, this.body)
    this.el.addEventListener('scroll', () => this.schedule())
  }

  /** Change de requete (filtres, tris, source) : on repart de la premiere page. */
  setQuery(query: Query): void {
    const same = this.query && JSON.stringify(this.query) === JSON.stringify(query)
    if (same) return
    this.query = query
    this.stopWatch?.()
    this.reset()
    this.stopWatch = this.host.engine.watch({ ...query, limit: PAGE_SIZE }, r => this.onFirstPage(r))
  }

  /** Les colonnes ou les types ont change : redessiner. */
  refresh(): void {
    this.renderHead()
    this.renderRows(true)
  }

  destroy(): void {
    this.stopWatch?.()
    this.stopWatch = null
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
    return this.host.columns().reduce((n, c) => n + c.width, 0) + 40
  }

  private renderHead(): void {
    const cols = this.host.columns()
    const cells = cols.map(col => {
      const th = h('div', { class: 'base-th', 'data-key': col.key, 'data-testid': 'base-th', title: col.label })
      th.style.width = `${col.width}px`
      const label = h('button', { class: 'base-th-label', type: 'button' }, col.label)
      label.addEventListener('click', () => this.host.columnMenu(col.key, th))
      th.append(label)
      if (!this.host.readOnly()) {
        const grip = h('span', { class: 'base-th-grip', title: 'Largeur' })
        grip.addEventListener('mousedown', e => this.startResize(e, col, th))
        th.append(grip)
      }
      return th
    })
    const add = h('button', { class: 'base-th-add', type: 'button', title: 'Ajouter une colonne', 'data-testid': 'base-add-column' }, '+')
    add.disabled = this.host.readOnly()
    add.addEventListener('click', () => this.host.addColumn(add))
    this.head.replaceChildren(...cells, add)
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
    const viewport = this.el.clientHeight || 600
    const top = this.el.scrollTop
    const first = Math.max(0, Math.floor(top / ROW_HEIGHT) - OVERSCAN)
    const last = Math.min(this.total - 1, Math.ceil((top + viewport) / ROW_HEIGHT) + OVERSCAN)
    this.body.style.height = `${this.total * ROW_HEIGHT}px`
    this.body.style.width = `${this.width()}px`
    const cols = this.host.columns()
    const colSig = JSON.stringify([cols, this.host.readOnly(), this.host.cells().members.length])
    const rows: HTMLElement[] = []
    const kept = new Map<string, { sig: string; el: HTMLElement }>()
    for (let i = first; i <= last; i++) {
      const page = Math.floor(i / PAGE_SIZE)
      const row = this.pages.get(page)?.[i - page * PAGE_SIZE]
      if (!row) {
        this.ensurePage(page)
        const ph = h('div', { class: 'base-tr base-tr-loading' }, '…')
        ph.style.top = `${i * ROW_HEIGHT}px`
        rows.push(ph)
        continue
      }
      // Meme contenu : meme element (un double-clic n'est pas perdu quand l'index bouge).
      const sig = JSON.stringify([row.title, row.path, row.values]) + colSig
      const prev = this.drawn.get(row.id)
      const el = prev && prev.sig === sig ? prev.el : this.renderRow(row, i, cols)
      el.style.top = `${i * ROW_HEIGHT}px`
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

  private renderRow(row: QueryRow, index: number, cols: TableColumn[]): HTMLElement {
    const light = row.path === ''
    const tr = h('div', { class: light ? 'base-tr base-tr-light' : 'base-tr', 'data-testid': 'base-row', 'data-id': row.id })
    tr.style.top = `${index * ROW_HEIGHT}px`
    const ctx = this.host.cells()
    const ro = this.host.readOnly()
    for (const col of cols) {
      const td = h('div', { class: 'base-td', 'data-key': col.key, tabindex: '-1' })
      td.style.width = `${col.width}px`
      if (col.key === TITLE_COLUMN) {
        td.classList.add('base-td-title')
        const name = light
          ? h('span', { class: 'base-title', 'data-testid': 'base-title' }, row.title || 'Sans titre')
          : h('a', { class: 'base-title base-title-page', href: '#', 'data-testid': 'base-title' }, row.title || 'Sans titre')
        if (!light) name.addEventListener('click', e => { e.preventDefault(); this.host.open(row) })
        td.append(h('span', { class: 'base-kind', title: light ? 'Ligne légère' : 'Page' }, light ? '·' : '📄'), name)
        if (!ro && light) {
          const promote = h('button', { class: 'base-row-action', type: 'button', title: 'Promouvoir en page', 'data-testid': 'base-promote' }, '⇪')
          promote.addEventListener('click', e => { e.stopPropagation(); this.host.promote(row) })
          const remove = h('button', { class: 'base-row-action', type: 'button', title: 'Supprimer la ligne', 'data-testid': 'base-remove' }, '×')
          remove.addEventListener('click', e => { e.stopPropagation(); this.host.remove(row) })
          td.append(promote, remove)
        }
        if (!ro) td.addEventListener('dblclick', () => this.editCell(td, col, row.title, v => this.host.rename(row, String(v ?? '').trim() || 'Sans titre')))
      } else {
        const value = row.values[col.key]
        td.append(renderValue(col.type, value, ctx))
        if (!ro) {
          if (col.type === 'checkbox') {
            td.classList.add('base-td-check')
            td.addEventListener('click', () => this.host.edit(row, col.key, !(value === true || value === 'true')))
          } else {
            td.addEventListener('dblclick', () => this.editCell(td, col, value, v => this.host.edit(row, col.key, v)))
            td.addEventListener('keydown', e => { if (e.key === 'Enter') this.editCell(td, col, value, v => this.host.edit(row, col.key, v)) })
          }
        }
      }
      tr.append(td)
    }
    return tr
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
