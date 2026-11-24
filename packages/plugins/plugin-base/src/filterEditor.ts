// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Editeur des filtres d'une vue : une ligne par filtre (propriete, operateur,
// valeur), la liaison « et » / « ou » sur la deuxieme ligne, et des groupes
// imbriques (un niveau, comme Notion). Les operateurs et la valeur dependent
// du type de la propriete : dates relatives pour une date, « Moi » pour une
// personne, Oui / Non pour une case.
import type { PropertyMember, PropertyType, PropertyValue } from '@savoire/plugin-api'
import { h, valueText } from './cells'
import {
  DATE_RANGES, ME, MAX_FILTER_DEPTH, RELATIVE_DAYS, isFilterGroup,
  type BaseFilter, type BaseFilterItem, type BaseFilterOp, type FilterMode,
} from './filters'

export interface FilterEditorHost {
  editable: boolean
  /** Cles proposees (colonnes, proprietes vues, titre). */
  keys(): string[]
  label(key: string): string
  typeOf(key: string): PropertyType
  members(): PropertyMember[]
  knownValues(key: string): Promise<string[]>
  /** Relation : les lignes de la base visee (lien et nom). */
  relationChoices?(key: string): Promise<{ link: string; title: string }[]>
}

interface OpInfo { op: BaseFilterOp; label: string; needsValue: boolean }

const TEXT_OPS: OpInfo[] = [
  { op: 'contains', label: 'contient', needsValue: true },
  { op: 'eq', label: 'est', needsValue: true },
  { op: 'neq', label: "n'est pas", needsValue: true },
  { op: 'startsWith', label: 'commence par', needsValue: true },
  { op: 'empty', label: 'est vide', needsValue: false },
  { op: 'notEmpty', label: "n'est pas vide", needsValue: false },
]

const NUMBER_OPS: OpInfo[] = [
  { op: 'eq', label: '=', needsValue: true },
  { op: 'neq', label: '≠', needsValue: true },
  { op: 'lt', label: '<', needsValue: true },
  { op: 'lte', label: '≤', needsValue: true },
  { op: 'gt', label: '>', needsValue: true },
  { op: 'gte', label: '≥', needsValue: true },
  { op: 'empty', label: 'est vide', needsValue: false },
  { op: 'notEmpty', label: "n'est pas vide", needsValue: false },
]

const DATE_OPS: OpInfo[] = [
  { op: 'eq', label: 'est le', needsValue: true },
  { op: 'lt', label: 'est avant le', needsValue: true },
  { op: 'gt', label: 'est après le', needsValue: true },
  { op: 'lte', label: 'est le ou avant le', needsValue: true },
  { op: 'gte', label: 'est le ou après le', needsValue: true },
  { op: 'within', label: 'est dans', needsValue: true },
  { op: 'neq', label: "n'est pas le", needsValue: true },
  { op: 'empty', label: 'est vide', needsValue: false },
  { op: 'notEmpty', label: "n'est pas vide", needsValue: false },
]

const CHOICE_OPS: OpInfo[] = [
  { op: 'eq', label: 'est', needsValue: true },
  { op: 'neq', label: "n'est pas", needsValue: true },
  { op: 'empty', label: 'est vide', needsValue: false },
  { op: 'notEmpty', label: "n'est pas vide", needsValue: false },
]

const LIST_OPS: OpInfo[] = [
  { op: 'contains', label: 'contient', needsValue: true },
  { op: 'neq', label: 'ne contient pas', needsValue: true },
  { op: 'empty', label: 'est vide', needsValue: false },
  { op: 'notEmpty', label: "n'est pas vide", needsValue: false },
]

const CHECK_OPS: OpInfo[] = [
  { op: 'eq', label: 'est', needsValue: true },
]

/** Operateurs proposes pour un type de propriete. */
export function opsFor(type: PropertyType): OpInfo[] {
  switch (type as string) {
    case 'number': return NUMBER_OPS
    case 'date': case 'created': case 'modified': return DATE_OPS
    case 'checkbox': return CHECK_OPS
    case 'select': case 'status': case 'person': return CHOICE_OPS
    case 'multiselect': case 'relation': case 'files': return LIST_OPS
    default: return TEXT_OPS
  }
}

/** Filtre neuf sur une cle : le premier operateur du type, sans valeur. */
export function defaultFilter(key: string, type: PropertyType): BaseFilter {
  if (type === 'checkbox') return { key, op: 'eq', value: true }
  return { key, op: opsFor(type)[0].op }
}

let listCounter = 0

function valueInput(host: FilterEditorHost, f: BaseFilter, set: (patch: Partial<BaseFilter>) => void): HTMLElement | null {
  const info = opsFor(host.typeOf(f.key)).find(o => o.op === f.op)
  if (info && !info.needsValue) return null
  const type = host.typeOf(f.key) as string
  const disabled = !host.editable
  const select = (options: [string, string][], current: string, onChange: (v: string) => void, testid = 'base-filter-value') => {
    const s = h('select', { class: 'base-input', 'data-testid': testid }, ...options.map(([v, l]) => h('option', { value: v }, l)))
    s.value = current
    s.disabled = disabled
    s.addEventListener('change', () => onChange(s.value))
    return s
  }
  if (f.op === 'within') {
    return select(DATE_RANGES.map(r => [r.value, r.label]), typeof f.value === 'string' ? f.value : '', v => set({ value: v }), 'base-filter-range')
  }
  if (type === 'date' || type === 'created' || type === 'modified') {
    const current = typeof f.value === 'string' ? f.value : ''
    const relative = RELATIVE_DAYS.some(r => r.value === current)
    const box = h('span', { class: 'base-filter-date' })
    const date = h('input', { class: 'base-input', type: 'date', 'data-testid': 'base-filter-value' })
    date.value = relative ? '' : current.slice(0, 10)
    date.hidden = relative
    date.disabled = disabled
    date.addEventListener('change', () => set({ value: date.value }))
    const which = select([['', 'Date précise'], ...RELATIVE_DAYS.map(r => [r.value, r.label] as [string, string])], relative ? current : '', v => {
      if (v) set({ value: v })
      else { date.hidden = false; date.focus() }
    }, 'base-filter-relative')
    box.append(which, date)
    return box
  }
  if (type === 'checkbox') {
    return select([['true', 'Cochée'], ['false', 'Non cochée']], f.value === false || f.value === 'false' ? 'false' : 'true', v => set({ value: v === 'true' }))
  }
  if (type === 'relation' && host.relationChoices) {
    const current = valueText(f.value)
    const s = select([['', '—'], ...(current ? [[current, current] as [string, string]] : [])], current, v => set({ value: v || undefined }))
    void host.relationChoices(f.key).then(rows => {
      s.replaceChildren(h('option', { value: '' }, '—'), ...rows.map(r => h('option', { value: r.link }, r.title)))
      if (current && !rows.some(r => r.link === current)) s.append(h('option', { value: current }, current))
      s.value = current
    })
    return s
  }
  if (type === 'person') {
    const id = valueText(f.value)
    const options: [string, string][] = [['', '—'], [ME, 'Moi'], ...host.members().map(m => [m.id, m.name] as [string, string])]
    if (id && !options.some(o => o[0] === id)) options.push([id, id])
    return select(options, id, v => set({ value: v || undefined }))
  }
  const input = h('input', { class: 'base-input', placeholder: 'valeur', 'data-testid': 'base-filter-value' })
  input.value = valueText(f.value)
  input.disabled = disabled
  if (type === 'number') input.type = 'number'
  input.addEventListener('change', () => {
    const raw = input.value
    const v: PropertyValue = type === 'number' && raw.trim() !== '' && Number.isFinite(Number(raw)) ? Number(raw) : raw
    set({ value: v })
  })
  if (type === 'select' || type === 'multiselect' || type === 'status' || type === 'text') {
    const list = h('datalist', { id: `base-filter-values-${++listCounter}` })
    input.setAttribute('list', list.id)
    void host.knownValues(f.key).then(values => list.replaceChildren(...values.map(v => h('option', { value: v }))))
    return h('span', {}, input, list)
  }
  return input
}

/**
 * L'editeur d'une liste de filtres et de sa liaison. `save` recoit la liste
 * et la liaison entieres (le manifeste les remplace en bloc).
 */
export function renderFilterEditor(
  host: FilterEditorHost,
  mode: FilterMode,
  items: readonly BaseFilterItem[],
  save: (mode: FilterMode, items: BaseFilterItem[]) => void,
  testid: string,
  depth = 0,
): HTMLElement {
  const box = h('div', { class: depth ? 'base-pop-list base-filter-group' : 'base-pop-list', 'data-testid': testid })
  const list = [...items]
  const put = (i: number, item: BaseFilterItem | null) => {
    const next = [...list]
    if (item) next[i] = item
    else next.splice(i, 1)
    save(mode, next)
  }
  const joiner = (i: number) => {
    if (i === 0) return h('span', { class: 'base-filter-join' }, 'Où')
    if (i > 1 || !host.editable) return h('span', { class: 'base-filter-join' }, mode === 'or' ? 'ou' : 'et')
    const s = h('select', { class: 'base-input base-filter-join', 'data-testid': `${testid}-mode` }, h('option', { value: 'and' }, 'et'), h('option', { value: 'or' }, 'ou'))
    s.value = mode
    s.addEventListener('change', () => save(s.value === 'or' ? 'or' : 'and', list))
    return s
  }
  const remove = (i: number) => {
    const b = h('button', { class: 'base-btn', type: 'button', title: 'Retirer', 'data-testid': 'base-filter-remove' }, '×')
    b.disabled = !host.editable
    b.addEventListener('click', () => put(i, null))
    return b
  }
  list.forEach((f, i) => {
    if (isFilterGroup(f)) {
      const inner = renderFilterEditor(host, f.mode, f.items, (m, xs) => put(i, { mode: m, items: xs }), `${testid}-group`, depth + 1)
      box.append(h('div', { class: 'base-pop-row base-filter-row' }, joiner(i), inner, remove(i)))
      return
    }
    const set = (patch: Partial<BaseFilter>) => put(i, { ...f, ...patch })
    const keySelect = h('select', { class: 'base-input', 'data-testid': 'base-filter-key' },
      h('option', { value: '' }, '—'), ...host.keys().map(k => h('option', { value: k }, host.label(k))))
    keySelect.value = f.key
    keySelect.disabled = !host.editable
    keySelect.addEventListener('change', () => {
      const key = keySelect.value
      const type = host.typeOf(key)
      // Nouveau type : l'operateur garde sa place s'il existe encore, la valeur repart de zero.
      const op = opsFor(type).some(o => o.op === f.op) ? f.op : defaultFilter(key, type).op
      put(i, { ...defaultFilter(key, type), op })
    })
    const ops = opsFor(host.typeOf(f.key))
    const opSelect = h('select', { class: 'base-input', 'data-testid': 'base-filter-op' }, ...ops.map(o => h('option', { value: o.op }, o.label)))
    if (!ops.some(o => o.op === f.op)) opSelect.append(h('option', { value: f.op }, f.op))
    opSelect.value = f.op
    opSelect.disabled = !host.editable
    opSelect.addEventListener('change', () => {
      const op = opSelect.value as BaseFilterOp
      // « est dans » attend une periode, les autres une date : on repart de zero entre les deux.
      const reset = (op === 'within') !== (f.op === 'within')
      set({ op, ...(reset ? { value: op === 'within' ? DATE_RANGES[0].value : undefined } : {}) })
    })
    box.append(h('div', { class: 'base-pop-row base-filter-row', 'data-testid': 'base-filter-row' },
      joiner(i), keySelect, opSelect, valueInput(host, f, set), remove(i)))
  })
  if (host.editable) {
    const add = h('button', { class: 'base-btn', type: 'button', 'data-testid': `${testid}-add` }, '+ Ajouter un filtre')
    add.addEventListener('click', () => save(mode, [...list, defaultFilter('@title', 'text')]))
    const actions = h('div', { class: 'base-pop-row' }, add)
    if (depth < MAX_FILTER_DEPTH - 1) {
      const group = h('button', { class: 'base-btn', type: 'button', 'data-testid': `${testid}-add-group` }, '+ Ajouter un groupe')
      group.addEventListener('click', () => save(mode, [...list, { mode: 'or', items: [defaultFilter('@title', 'text')] }]))
      actions.append(group)
    }
    box.append(actions)
  }
  return box
}
