// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Sous-groupes d'un kanban (« couloirs ») : une rangee par valeur d'une
// seconde propriete, chacune avec son kanban (memes colonnes). Une carte
// glissee dans une colonne change la propriete des colonnes ; une page
// creee dans un couloir prend aussi la valeur du couloir.
import type { PropertyValue, Query, QueryFilter } from '@savoire/plugin-api'
import { h, renderValue } from './cells'
import { BaseKanban, type KanbanHost } from './kanban'
import { groupFilter, groupId, groupLabel, orderGroups } from './groups'
import type { GroupSpec } from './groupedTable'

export interface SwimlanesHost extends KanbanHost {
  toggleGroup(id: string): void
}

interface Lane {
  value: PropertyValue
  el: HTMLElement
  count: HTMLElement
  board: BaseKanban | null
}

export class Swimlanes {
  readonly el: HTMLElement
  private query: Query | null = null
  private groupBy = ''
  private spec: GroupSpec | null = null
  private stop: (() => void) | null = null
  private lanes = new Map<string, Lane>()
  private counts = new Map<string, number>()

  constructor(private readonly host: SwimlanesHost) {
    this.el = h('div', { class: 'base-swimlanes', 'data-testid': 'base-swimlanes' })
  }

  setQuery(query: Query, groupBy: string, spec: GroupSpec, force = false): void {
    const sig = JSON.stringify([query, groupBy, { ...spec, collapsed: [] }])
    const prev = this.query && JSON.stringify([this.query, this.groupBy, { ...this.spec, collapsed: [] }])
    this.spec = spec
    if (sig === prev && !force) { this.sync([...this.lanes.values()].map(l => l.value)); return }
    this.destroy()
    this.query = query
    this.groupBy = groupBy
    this.spec = spec
    this.stop = this.host.engine.watch({ ...query, groupBy: spec.field, limit: 1 }, r => {
      this.counts = new Map((r.groups ?? []).map(g => [groupId(g.key), g.count]))
      const values = (r.groups ?? []).map(g => g.key).filter(v => !Array.isArray(v))
      this.sync(orderGroups(values, spec.type, spec.options))
    })
  }

  refresh(): void {
    for (const l of this.lanes.values()) l.board?.refresh()
  }

  destroy(): void {
    this.query = null
    this.stop?.()
    this.stop = null
    for (const l of this.lanes.values()) l.board?.destroy()
    this.lanes.clear()
    this.el.replaceChildren()
  }

  private sync(values: PropertyValue[]): void {
    const spec = this.spec!
    const wanted = new Map(values.map(v => [groupId(v), v]))
    for (const [id, l] of this.lanes) if (!wanted.has(id)) { l.board?.destroy(); this.lanes.delete(id) }
    const ordered: HTMLElement[] = []
    for (const [id, value] of wanted) {
      let lane = this.lanes.get(id)
      if (!lane) {
        const count = h('span', { class: 'base-lane-count' })
        const toggle = h('button', { class: 'base-group-toggle', type: 'button', 'data-testid': 'base-group-toggle' }, '▾')
        toggle.addEventListener('click', () => this.host.toggleGroup(id))
        const label = value === null
          ? h('span', { class: 'base-pill' }, 'Sans valeur')
          : spec.type === 'checkbox' ? h('span', {}, groupLabel(value, spec.type)) : renderValue(spec.type === 'multiselect' ? 'select' : spec.type, value, this.host.cells(), spec.key)
        const el = h('div', { class: 'base-swimlane', 'data-testid': 'base-swimlane', 'data-value': id },
          h('div', { class: 'base-group-head' }, toggle, label, count))
        lane = { value, el, count, board: null }
        this.lanes.set(id, lane)
      }
      const collapsed = spec.collapsed.includes(id)
      if (collapsed && lane.board) { lane.board.destroy(); lane.board.el.remove(); lane.board = null }
      if (!collapsed && !lane.board) lane.board = this.createBoard(value, lane.el)
      lane.el.classList.toggle('base-group-collapsed', collapsed)
      lane.count.textContent = String(this.counts.get(id) ?? 0)
      ordered.push(lane.el)
    }
    this.el.replaceChildren(...ordered)
  }

  private createBoard(value: PropertyValue, into: HTMLElement): BaseKanban {
    const spec = this.spec!
    const q = this.query!
    const filter: QueryFilter = groupFilter(spec.field, value)
    const own: Record<string, PropertyValue> = value === null || !('prop' in spec.field) ? {} : { [spec.key]: spec.type === 'multiselect' ? [String(value)] : value }
    const board = new BaseKanban({ ...this.host, addPage: values => this.host.addPage({ ...own, ...values }) })
    board.setQuery({ ...q, where: q.where ? { and: [q.where, filter] } : filter }, this.groupBy)
    into.append(board.el)
    return board
  }
}
