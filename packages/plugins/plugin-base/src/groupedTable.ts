// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Tableau groupe : une section par valeur de la propriete de regroupement
// (ou par jour, semaine, mois, annee pour une date), chacune avec son
// en-tete (repliable, nombre de lignes) et son tableau, suivi en direct.
// Les groupes viennent du moteur (Query.groupBy), plus les options
// declarees ; leur ordre est celui des options (groups.ts).
import type { PropertyOption, PropertyType, PropertyValue, Query, QueryField, QueryFilter } from '@savoire/plugin-api'
import { h, renderValue } from './cells'
import { BaseTable, type TableHost } from './table'
import { groupFilter, groupId, groupLabel, orderGroups, type DateGrouping } from './groups'

export interface GroupSpec {
  key: string
  type: PropertyType
  field: QueryField
  options: PropertyOption[]
  dateGroup?: DateGrouping
  hideEmpty: boolean
  collapsed: string[]
}

export interface GroupedTableHost extends TableHost {
  /** Replie ou deplie un groupe (enregistre dans la vue). */
  toggleGroup(id: string): void
  /** Nouvelle ligne dans un groupe : ses valeurs. */
  addPageIn(values: Record<string, PropertyValue>): void
}

interface Section {
  value: PropertyValue
  el: HTMLElement
  count: HTMLElement
  table: BaseTable | null
}

export class GroupedTable {
  readonly el: HTMLElement
  private query: Query | null = null
  private spec: GroupSpec | null = null
  private stop: (() => void) | null = null
  private sections = new Map<string, Section>()
  private counts = new Map<string, number>()

  constructor(private readonly host: GroupedTableHost) {
    this.el = h('div', { class: 'base-grouped', 'data-testid': 'base-grouped' })
  }

  setQuery(query: Query, spec: GroupSpec, force = false): void {
    const sig = JSON.stringify([query, { ...spec, collapsed: [] }])
    const prev = this.query && JSON.stringify([this.query, { ...this.spec, collapsed: [] }])
    const collapsedChanged = JSON.stringify(spec.collapsed) !== JSON.stringify(this.spec?.collapsed ?? [])
    this.spec = spec
    if (sig === prev && !force) {
      if (collapsedChanged) this.syncSections([...this.sections.values()].map(s => s.value))
      return
    }
    this.destroy()
    this.query = query
    this.spec = spec
    this.stop = this.host.engine.watch({ ...query, groupBy: spec.field, limit: 1 }, r => {
      this.counts = new Map((r.groups ?? []).map(g => [groupId(g.key), g.count]))
      const values: PropertyValue[] = (r.groups ?? []).map(g => g.key)
      // Les options declarees ont leur groupe, meme vide (sauf « masquer les groupes vides »).
      if (!spec.hideEmpty && !spec.dateGroup) for (const o of spec.options) values.push(o.value)
      this.syncSections(orderGroups(values.filter(v => !Array.isArray(v)), spec.type, spec.options))
    })
  }

  refresh(): void {
    for (const s of this.sections.values()) s.table?.refresh()
  }

  destroy(): void {
    this.query = null
    this.stop?.()
    this.stop = null
    for (const s of this.sections.values()) s.table?.destroy()
    this.sections.clear()
    this.el.replaceChildren()
  }

  private syncSections(values: PropertyValue[]): void {
    const spec = this.spec!
    const wanted = new Map(values.map(v => [groupId(v), v]))
    for (const [id, s] of this.sections) {
      if (!wanted.has(id)) { s.table?.destroy(); this.sections.delete(id) }
    }
    const ordered: HTMLElement[] = []
    for (const [id, value] of wanted) {
      let s = this.sections.get(id)
      const collapsed = spec.collapsed.includes(id)
      if (!s) { s = this.createSection(value); this.sections.set(id, s) }
      if (collapsed && s.table) { s.table.destroy(); s.table.el.remove(); s.table = null }
      if (!collapsed && !s.table) s.table = this.createTable(value, s.el)
      s.el.classList.toggle('base-group-collapsed', collapsed)
      s.count.textContent = String(this.counts.get(id) ?? 0)
      ordered.push(s.el)
    }
    this.el.replaceChildren(...ordered)
  }

  private createSection(value: PropertyValue): Section {
    const spec = this.spec!
    const id = groupId(value)
    const count = h('span', { class: 'base-lane-count' })
    const toggle = h('button', { class: 'base-group-toggle', type: 'button', title: 'Replier ou déplier', 'data-testid': 'base-group-toggle' }, '▾')
    const label = value === null
      ? h('span', { class: 'base-pill' }, 'Sans valeur')
      : spec.dateGroup || spec.type === 'checkbox'
        ? h('span', { class: 'base-group-label' }, groupLabel(value, spec.type, spec.dateGroup, this.host.cells().members))
        : renderValue(spec.type === 'multiselect' ? 'select' : spec.type, value, this.host.cells(), spec.key)
    const head = h('div', { class: 'base-group-head', 'data-testid': 'base-group-head', 'data-value': id }, toggle, label, count)
    toggle.addEventListener('click', () => this.host.toggleGroup(id))
    const el = h('div', { class: 'base-group', 'data-testid': 'base-group-section' }, head)
    return { value, el, count, table: null }
  }

  private createTable(value: PropertyValue, into: HTMLElement): BaseTable {
    const spec = this.spec!
    const q = this.query!
    const filter: QueryFilter = groupFilter(spec.field, value)
    const where: QueryFilter = q.where ? { and: [q.where, filter] } : filter
    // Une nouvelle ligne prend la valeur du groupe (pas pour un groupe de dates).
    const values: Record<string, PropertyValue> = value === null || spec.dateGroup || !('prop' in spec.field) ? {} : { [spec.key]: spec.type === 'multiselect' ? [String(value)] : value }
    const table = new BaseTable({
      ...this.host,
      onResult: () => {},
      totals: undefined,
      totalMenu: undefined,
      // Une selection et un ordre manuel par section n'auraient pas de sens.
      selectionChanged: undefined,
      canReorder: () => false,
      addRow: () => this.host.addPageIn(values),
    }, { embedded: true })
    table.setQuery({ ...q, where })
    into.append(table.el)
    return table
  }
}
