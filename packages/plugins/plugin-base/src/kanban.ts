// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Vue kanban d'une base : une colonne par valeur d'une propriete de choix
// (celles deja vues dans les lignes, plus les options declarees du type),
// et « Sans valeur ». Deplacer une carte change la valeur de la ligne.
// Chaque colonne est une requete suivie en direct (api.query.watch).
import type { IQueryEngine, PropertyValue, Query, QueryFilter, QueryRow } from '@savoire/plugin-api'
import { h, renderValue, valueText, type CellContext } from './cells'
import type { TableColumn } from './table'

const CARDS_PER_LANE = 100

export interface KanbanHost {
  engine: IQueryEngine
  readOnly(): boolean
  /** Colonnes de la vue (les premieres s'affichent sur les cartes). */
  columns(): TableColumn[]
  cells(): CellContext
  /** Valeurs declarees du type (options), toujours montrees. */
  options(key: string): string[]
  edit(row: QueryRow, key: string, value: PropertyValue): void
  open(row: QueryRow): void
  addPage(values: Record<string, PropertyValue>): void
}

interface Lane {
  key: PropertyValue
  el: HTMLElement
  cards: HTMLElement
  stop: () => void
}

function laneId(key: PropertyValue): string {
  return JSON.stringify(key)
}

export class BaseKanban {
  readonly el: HTMLElement
  private query: Query | null = null
  private group = ''
  private stopGroups: (() => void) | null = null
  private lanes = new Map<string, Lane>()
  private rows = new Map<string, QueryRow>()

  constructor(private readonly host: KanbanHost) {
    this.el = h('div', { class: 'base-kanban', 'data-testid': 'base-kanban' })
  }

  setQuery(query: Query, groupBy: string): void {
    if (this.query && JSON.stringify(this.query) === JSON.stringify(query) && this.group === groupBy) return
    this.destroy()
    this.query = query
    this.group = groupBy
    if (!groupBy) {
      this.el.replaceChildren(h('div', { class: 'base-hint' }, 'Choisissez une propriété de regroupement (« Grouper par »).'))
      return
    }
    this.stopGroups = this.host.engine.watch({ ...query, groupBy: { prop: groupBy }, limit: 1 }, r => {
      const keys: PropertyValue[] = this.host.options(groupBy)
      for (const g of r.groups ?? []) if (g.key !== null && !Array.isArray(g.key) && !keys.some(k => laneId(k) === laneId(g.key))) keys.push(g.key)
      keys.push(null)
      this.syncLanes(keys)
    })
  }

  refresh(): void {
    for (const lane of this.lanes.values()) this.renderCards(lane, [...this.rows.values()].filter(r => laneId(this.valueOf(r)) === laneId(lane.key)))
  }

  destroy(): void {
    this.stopGroups?.()
    this.stopGroups = null
    for (const lane of this.lanes.values()) lane.stop()
    this.lanes.clear()
    this.rows.clear()
    this.el.replaceChildren()
  }

  private valueOf(row: QueryRow): PropertyValue {
    const v = row.values[this.group]
    if (v === undefined || v === '' || (Array.isArray(v) && v.length === 0)) return null
    return Array.isArray(v) ? v[0] : v
  }

  private laneFilter(key: PropertyValue): QueryFilter {
    const field = { prop: this.group }
    return key === null ? { field, op: 'empty' } : { field, op: 'eq', value: key }
  }

  private syncLanes(keys: PropertyValue[]): void {
    const wanted = new Map(keys.map(k => [laneId(k), k]))
    for (const [id, lane] of this.lanes) {
      if (!wanted.has(id)) { lane.stop(); lane.el.remove(); this.lanes.delete(id) }
    }
    const ordered: HTMLElement[] = []
    for (const [id, key] of wanted) {
      let lane = this.lanes.get(id)
      if (!lane) lane = this.createLane(key)
      this.lanes.set(id, lane)
      ordered.push(lane.el)
    }
    this.el.replaceChildren(...ordered)
  }

  private createLane(key: PropertyValue): Lane {
    const title = key === null ? 'Sans valeur' : valueText(key)
    const count = h('span', { class: 'base-lane-count' })
    const cards = h('div', { class: 'base-lane-cards' })
    const el = h('div', { class: 'base-lane', 'data-testid': 'base-lane', 'data-value': title },
      h('div', { class: 'base-lane-head' }, h('span', { class: 'base-pill' }, title), count),
      cards)
    if (!this.host.readOnly()) {
      const add = h('button', { class: 'base-lane-add', type: 'button', 'data-testid': 'base-lane-add' }, '+ Nouvelle page')
      add.addEventListener('click', () => this.host.addPage(key === null ? {} : { [this.group]: key }))
      el.append(add)
      el.addEventListener('dragover', e => { e.preventDefault(); el.classList.add('base-lane-over') })
      el.addEventListener('dragleave', () => el.classList.remove('base-lane-over'))
      el.addEventListener('drop', e => {
        e.preventDefault()
        el.classList.remove('base-lane-over')
        const id = e.dataTransfer?.getData('text/x-base-row') ?? ''
        const row = this.rows.get(id)
        if (row && laneId(this.valueOf(row)) !== laneId(key)) this.host.edit(row, this.group, key)
      })
    }
    const lane: Lane = { key, el, cards, stop: () => {} }
    const where = this.query?.where ? { and: [this.query.where, this.laneFilter(key)] } : this.laneFilter(key)
    lane.stop = this.host.engine.watch({ ...this.query!, where, limit: CARDS_PER_LANE }, r => {
      for (const row of r.rows) this.rows.set(row.id, row)
      count.textContent = String(r.total)
      this.renderCards(lane, r.rows)
    })
    return lane
  }

  private renderCards(lane: Lane, rows: QueryRow[]): void {
    const ctx = this.host.cells()
    const fields = this.host.columns().filter(c => c.key !== this.group && !c.key.startsWith('@')).slice(0, 3)
    lane.cards.replaceChildren(...rows.map(row => {
      const card = h('div', { class: 'base-card', 'data-testid': 'base-card', 'data-id': row.id, draggable: this.host.readOnly() ? 'false' : 'true' })
      const title = h(row.path ? 'a' : 'span', { class: 'base-card-title', href: row.path ? '#' : undefined }, row.title || 'Sans titre')
      if (row.path) title.addEventListener('click', e => { e.preventDefault(); this.host.open(row) })
      card.append(title)
      for (const f of fields) {
        const v = row.values[f.key]
        if (v === undefined || v === null || (Array.isArray(v) && v.length === 0)) continue
        card.append(h('div', { class: 'base-card-field' }, h('span', { class: 'base-card-label' }, f.label), renderValue(f.type, v, ctx)))
      }
      card.addEventListener('dragstart', e => {
        e.dataTransfer?.setData('text/x-base-row', row.id)
        if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move'
      })
      return card
    }))
  }
}
