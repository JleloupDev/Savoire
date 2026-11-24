// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Calendrier d'une base : un mois (semaines du lundi au dimanche), les
// lignes posees au jour de leur date ; une periode « debut/fin » s'etend sur
// ses jours. Glisser une ligne sur un autre jour deplace sa date (l'heure et
// la duree restent) ; « + » sur un jour cree une page a cette date.
import { splitDateRange } from '@savoire/plugin-api'
import type { PropertyValue, Query, QueryFilter, QueryRow } from '@savoire/plugin-api'
import { h } from '../dom'
import { isoDay } from '../filters'
import type { LayoutHost } from './host'

const WEEKDAYS = ['lun.', 'mar.', 'mer.', 'jeu.', 'ven.', 'sam.', 'dim.']
const MONTHS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre']
const MAX_ROWS = 500
/** Une periode qui commence avant la grille y entre si elle a commence moins de ce nombre de jours avant. */
const LOOKBACK_DAYS = 62

const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n)

function parseDay(s: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s)
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null
}

const dayDiff = (a: Date, b: Date) => Math.round((Date.UTC(b.getFullYear(), b.getMonth(), b.getDate()) - Date.UTC(a.getFullYear(), a.getMonth(), a.getDate())) / 86_400_000)

/** Deplace une valeur de date de `days` jours (heure et fin comprises). */
export function shiftDate(value: string, days: number): string {
  const shift = (s: string) => {
    const d = parseDay(s)
    return d ? isoDay(addDays(d, days)) + s.slice(10) : s
  }
  const { start, end } = splitDateRange(value)
  return end ? `${shift(start)}/${shift(end)}` : shift(start)
}

/** Premier jour (lundi) de la grille d'un mois, et le lendemain du dernier. */
export function monthGrid(month: Date): { start: Date; end: Date } {
  const first = new Date(month.getFullYear(), month.getMonth(), 1)
  const start = addDays(first, -((first.getDay() + 6) % 7))
  return { start, end: addDays(start, 42) }
}

export class BaseCalendar {
  readonly el: HTMLElement
  private readonly title: HTMLElement
  private readonly grid: HTMLElement
  private month: Date
  private query: Query | null = null
  private dateKey = ''
  private stop: (() => void) | null = null
  private rows: QueryRow[] = []
  private truncated = false

  constructor(private readonly host: LayoutHost, now = new Date()) {
    this.month = new Date(now.getFullYear(), now.getMonth(), 1)
    this.title = h('span', { class: 'base-cal-title', 'data-testid': 'base-cal-title' })
    const nav = (text: string, testid: string, delta: number | null) => {
      const b = h('button', { class: 'base-btn', type: 'button', 'data-testid': testid }, text)
      b.addEventListener('click', () => {
        const n = new Date()
        this.month = delta === null ? new Date(n.getFullYear(), n.getMonth(), 1) : new Date(this.month.getFullYear(), this.month.getMonth() + delta, 1)
        this.follow()
      })
      return b
    }
    this.grid = h('div', { class: 'base-cal-grid', 'data-testid': 'base-cal-grid' })
    this.el = h('div', { class: 'base-cal', 'data-testid': 'base-calendar' },
      h('div', { class: 'base-cal-head' }, nav('‹', 'base-cal-prev', -1), this.title, nav('›', 'base-cal-next', 1), nav('Aujourd’hui', 'base-cal-today', null)),
      this.grid)
  }

  setQuery(query: Query, dateKey: string, force = false): void {
    if (!force && this.query && JSON.stringify(this.query) === JSON.stringify(query) && this.dateKey === dateKey) return
    this.query = query
    this.dateKey = dateKey
    this.follow()
  }

  refresh(): void {
    this.render()
  }

  destroy(): void {
    this.stop?.()
    this.stop = null
    this.query = null
    this.grid.replaceChildren()
  }

  private follow(): void {
    this.stop?.()
    this.stop = null
    this.rows = []
    this.title.textContent = `${MONTHS[this.month.getMonth()]} ${this.month.getFullYear()}`
    if (!this.query || !this.dateKey) {
      this.grid.replaceChildren(h('div', { class: 'base-hint' }, 'Choisissez la propriété de date (réglages de la vue).'))
      return
    }
    const { start, end } = monthGrid(this.month)
    const field = { prop: this.dateKey }
    const range: QueryFilter = { and: [{ field, op: 'gte', value: isoDay(addDays(start, -LOOKBACK_DAYS)) }, { field, op: 'lt', value: isoDay(end) }] }
    const where: QueryFilter = this.query.where ? { and: [this.query.where, range] } : range
    this.stop = this.host.engine.watch({ ...this.query, where, sort: [{ field }], limit: MAX_ROWS }, r => {
      this.rows = r.rows
      this.truncated = r.total > r.rows.length
      this.render()
    })
    this.render()
  }

  /** Jours couverts par une ligne : [debut, fin], fin incluse. */
  private span(row: QueryRow): [Date, Date] | null {
    const v = this.host.valueOf(row, this.dateKey)
    if (typeof v !== 'string') return null
    const { start, end } = splitDateRange(v)
    const a = parseDay(start)
    if (!a) return null
    const b = end ? parseDay(end) : null
    return [a, b && b >= a ? b : a]
  }

  private render(): void {
    if (!this.query || !this.dateKey) return
    const { start } = monthGrid(this.month)
    const today = isoDay(new Date())
    const byDay = new Map<string, QueryRow[]>()
    for (const row of this.rows) {
      const s = this.span(row)
      if (!s) continue
      const days = Math.min(42, dayDiff(s[0], s[1]))
      for (let i = 0; i <= days; i++) {
        const key = isoDay(addDays(s[0], i))
        const list = byDay.get(key) ?? []
        list.push(row)
        byDay.set(key, list)
      }
    }
    const ro = this.host.readOnly()
    const cells: HTMLElement[] = WEEKDAYS.map(d => h('div', { class: 'base-cal-weekday' }, d))
    for (let i = 0; i < 42; i++) {
      const day = addDays(start, i)
      const key = isoDay(day)
      const inMonth = day.getMonth() === this.month.getMonth()
      const cls = `base-cal-day${inMonth ? '' : ' base-cal-out'}${key === today ? ' base-cal-today' : ''}`
      const cell = h('div', { class: cls, 'data-testid': 'base-cal-day', 'data-day': key },
        h('div', { class: 'base-cal-num' }, String(day.getDate())))
      for (const row of byDay.get(key) ?? []) cell.append(this.chip(row, key))
      if (!ro) {
        const add = h('button', { class: 'base-cal-add', type: 'button', title: 'Nouvelle page ce jour-là', 'data-testid': 'base-cal-add' }, '+')
        add.addEventListener('click', () => void this.host.addPage({ [this.dateKey]: key }))
        cell.append(add)
        cell.addEventListener('dragover', e => { e.preventDefault(); cell.classList.add('base-cal-over') })
        cell.addEventListener('dragleave', () => cell.classList.remove('base-cal-over'))
        cell.addEventListener('drop', e => {
          e.preventDefault()
          cell.classList.remove('base-cal-over')
          const [id, from] = (e.dataTransfer?.getData('text/x-base-row') ?? '').split('|')
          this.move(id, from, key)
        })
      }
      cells.push(cell)
    }
    this.grid.replaceChildren(...cells)
    if (this.truncated) this.grid.append(h('div', { class: 'base-hint base-cal-note' }, `Plus de ${MAX_ROWS} lignes ce mois-ci : seules les premières sont montrées.`))
  }

  /** Deplace la ligne `id` (prise au jour `from`) vers `to`. */
  move(id: string, from: string, to: string): void {
    const row = this.rows.find(r => r.id === id)
    const a = parseDay(from), b = parseDay(to)
    if (!row || !a || !b) return
    const delta = dayDiff(a, b)
    const v = this.host.valueOf(row, this.dateKey)
    if (!delta || typeof v !== 'string') return
    this.host.edit(row, this.dateKey, shiftDate(v, delta) as PropertyValue)
  }

  private chip(row: QueryRow, day: string): HTMLElement {
    const chip = h('div', { class: 'base-cal-chip', 'data-testid': 'base-cal-chip', 'data-id': row.id, draggable: this.host.readOnly() ? 'false' : 'true', title: row.title },
      row.title || 'Sans titre')
    chip.addEventListener('click', e => { e.stopPropagation(); if (row.path) this.host.open(row) })
    chip.addEventListener('dragstart', e => {
      e.dataTransfer?.setData('text/x-base-row', `${row.id}|${day}`)
      if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move'
    })
    return chip
  }
}
