// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Frise (diagramme de Gantt) d'une base : une ligne par page, une barre du
// debut a la fin (une periode « debut/fin », ou une propriete de fin), sur
// une echelle de jours, de semaines ou de mois. Glisser une barre la
// deplace ; tirer son bord droit change la fin. Avec une relation de
// dependance, une fleche relie une ligne a celles qui l'attendent.
import { splitDateRange } from '@savoire/plugin-api'
import type { PropertyValue, Query, QueryFilter, QueryRow } from '@savoire/plugin-api'
import { h } from '../dom'
import { isoDay } from '../filters'
import { asLinks, linkKey } from '../relations'
import { shiftDate } from './calendar'
import type { LayoutHost } from './host'
import type { TimelineScale } from '../manifest'

const MAX_ROWS = 500
const ROW = 30
const PX: Record<TimelineScale, number> = { day: 36, week: 14, month: 4 }
const SPAN: Record<TimelineScale, number> = { day: 42, week: 120, month: 400 }
const MONTHS = ['janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin', 'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.']

const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n)
const parseDay = (s: string): Date | null => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s)
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null
}
const dayDiff = (a: Date, b: Date) => Math.round((Date.UTC(b.getFullYear(), b.getMonth(), b.getDate()) - Date.UTC(a.getFullYear(), a.getMonth(), a.getDate())) / 86_400_000)

export interface TimelineOptions {
  dateBy: string
  /** Propriete de fin ; '' : la fin de la periode de dateBy. */
  endBy: string
  scale: TimelineScale
  /** Relation « bloque » : fleches vers les lignes liees. '' : aucune. */
  dependsOn?: string
}

export class BaseTimeline {
  readonly el: HTMLElement
  private readonly names: HTMLElement
  private readonly canvas: HTMLElement
  private readonly scroller: HTMLElement
  private query: Query | null = null
  private opts: TimelineOptions = { dateBy: '', endBy: '', scale: 'day' }
  private start: Date
  private stop: (() => void) | null = null
  private rows: QueryRow[] = []

  constructor(private readonly host: LayoutHost, now = new Date()) {
    this.start = addDays(new Date(now.getFullYear(), now.getMonth(), now.getDate()), -7)
    const nav = (text: string, testid: string, run: () => void) => {
      const b = h('button', { class: 'base-btn', type: 'button', 'data-testid': testid }, text)
      b.addEventListener('click', run)
      return b
    }
    const step = () => Math.round(SPAN[this.opts.scale] / 3)
    this.names = h('div', { class: 'base-tl-names' })
    this.canvas = h('div', { class: 'base-tl-canvas', 'data-testid': 'base-tl-canvas' })
    this.scroller = h('div', { class: 'base-tl-scroll' }, this.canvas)
    this.el = h('div', { class: 'base-tl', 'data-testid': 'base-timeline' },
      h('div', { class: 'base-cal-head' },
        nav('‹', 'base-tl-prev', () => { this.start = addDays(this.start, -step()); this.follow() }),
        nav('Aujourd’hui', 'base-tl-today', () => { const n = new Date(); this.start = addDays(new Date(n.getFullYear(), n.getMonth(), n.getDate()), -7); this.follow() }),
        nav('›', 'base-tl-next', () => { this.start = addDays(this.start, step()); this.follow() })),
      h('div', { class: 'base-tl-body' }, this.names, this.scroller))
  }

  setQuery(query: Query, opts: TimelineOptions, force = false): void {
    if (!force && this.query && JSON.stringify([this.query, this.opts]) === JSON.stringify([query, opts])) return
    this.query = query
    this.opts = opts
    this.follow()
  }

  refresh(): void {
    this.render()
  }

  destroy(): void {
    this.stop?.()
    this.stop = null
    this.query = null
    this.canvas.replaceChildren()
    this.names.replaceChildren()
  }

  private follow(): void {
    this.stop?.()
    this.stop = null
    if (!this.query || !this.opts.dateBy) {
      this.canvas.replaceChildren(h('div', { class: 'base-hint' }, 'Choisissez la propriété de date (réglages de la vue).'))
      this.names.replaceChildren()
      return
    }
    const field = { prop: this.opts.dateBy }
    const end = addDays(this.start, SPAN[this.opts.scale])
    // Ce qui commence avant la fin de la fenetre ; la fin se verifie ici.
    const range: QueryFilter = { and: [{ field, op: 'notEmpty' }, { field, op: 'lt', value: isoDay(end) }] }
    const where: QueryFilter = this.query.where ? { and: [this.query.where, range] } : range
    this.stop = this.host.engine.watch({ ...this.query, where, sort: [{ field }], limit: MAX_ROWS }, r => { this.rows = r.rows; this.render() })
  }

  /** Debut et fin (incluse) d'une ligne. */
  span(row: QueryRow): [Date, Date] | null {
    const v = this.host.valueOf(row, this.opts.dateBy)
    if (typeof v !== 'string') return null
    const { start, end } = splitDateRange(v)
    const a = parseDay(start)
    if (!a) return null
    let b: Date | null = null
    if (this.opts.endBy) { const e = this.host.valueOf(row, this.opts.endBy); if (typeof e === 'string') b = parseDay(splitDateRange(e).start) }
    else if (end) b = parseDay(end)
    return [a, b && b >= a ? b : a]
  }

  private render(): void {
    if (!this.query || !this.opts.dateBy) return
    const px = PX[this.opts.scale]
    const days = SPAN[this.opts.scale]
    const width = days * px
    const visible = this.rows.map(r => ({ row: r, s: this.span(r) })).filter(x => x.s && dayDiff(this.start, x.s[1]) >= 0) as { row: QueryRow; s: [Date, Date] }[]
    // En-tete : jours (lundi en gras), ou debut de chaque mois.
    const head = h('div', { class: this.opts.scale === 'day' ? 'base-tl-ticks base-tl-ticks-day' : 'base-tl-ticks' })
    head.style.width = `${width}px`
    for (let i = 0; i < days; i++) {
      const d = addDays(this.start, i)
      // Echelle des jours : le mois au-dessus des numeros, a son premier jour visible.
      if (this.opts.scale === 'day' && (i === 0 || d.getDate() === 1)) {
        const m = h('span', { class: 'base-tl-month' }, `${MONTHS[d.getMonth()]} ${d.getFullYear()}`)
        m.style.left = `${i * px}px`
        head.append(m)
      }
      const label = this.opts.scale === 'day' ? String(d.getDate())
        : d.getDate() === 1 ? `${MONTHS[d.getMonth()]}${d.getMonth() === 0 ? ` ${d.getFullYear()}` : ''}`
          : this.opts.scale === 'week' && d.getDay() === 1 ? String(d.getDate()) : ''
      if (!label && this.opts.scale !== 'day') continue
      const tick = h('span', { class: `base-tl-tick${d.getDay() === 1 ? ' base-tl-monday' : ''}${isoDay(d) === isoDay(new Date()) ? ' base-tl-now' : ''}` }, label)
      tick.style.left = `${i * px}px`
      if (this.opts.scale === 'day') tick.style.width = `${px}px`
      head.append(tick)
    }
    const today = dayDiff(this.start, new Date())
    const lanes = h('div', { class: 'base-tl-lanes' })
    lanes.style.width = `${width}px`
    lanes.style.height = `${visible.length * ROW}px`
    if (today >= 0 && today < days) {
      const line = h('div', { class: 'base-tl-today-line' })
      line.style.left = `${today * px + px / 2}px`
      lanes.append(line)
    }
    const names: HTMLElement[] = [h('div', { class: 'base-tl-name base-tl-name-head' }, ' ')]
    const position = new Map<string, { x0: number; x1: number; y: number }>()
    visible.forEach(({ row, s }, i) => {
      const x0 = dayDiff(this.start, s[0]) * px
      const x1 = (dayDiff(this.start, s[1]) + 1) * px
      position.set(row.path ? linkKey(row.path) : row.id, { x0, x1, y: i * ROW + ROW / 2 })
      const bar = h('div', { class: 'base-tl-bar', 'data-testid': 'base-tl-bar', 'data-id': row.id, title: row.title }, row.title || 'Sans titre')
      bar.style.left = `${x0}px`
      bar.style.width = `${Math.max(px, x1 - x0)}px`
      bar.style.top = `${i * ROW + 4}px`
      if (!this.host.readOnly()) this.draggable(bar, row, px)
      bar.addEventListener('dblclick', () => { if (row.path) this.host.open(row) })
      lanes.append(bar)
      const name = h('div', { class: 'base-tl-name' }, h(row.path ? 'a' : 'span', { href: row.path ? '#' : undefined }, row.title || 'Sans titre'))
      name.querySelector('a')?.addEventListener('click', e => { e.preventDefault(); this.host.open(row) })
      names.push(name)
    })
    // Dependances : une fleche de la fin d'une ligne au debut de celles qu'elle bloque.
    if (this.opts.dependsOn) {
      const ns = 'http://www.w3.org/2000/svg'
      const svg = document.createElementNS(ns, 'svg')
      svg.setAttribute('class', 'base-tl-deps')
      svg.setAttribute('width', String(width))
      svg.setAttribute('height', String(visible.length * ROW))
      for (const { row } of visible) {
        const from = position.get(row.path ? linkKey(row.path) : row.id)
        if (!from) continue
        for (const link of asLinks(this.host.valueOf(row, this.opts.dependsOn))) {
          const to = position.get(linkKey(link))
          if (!to) continue
          const path = document.createElementNS(ns, 'path')
          const mid = Math.max(from.x1 + 8, to.x0 - 8)
          path.setAttribute('d', `M${from.x1},${from.y} H${mid} V${to.y} H${to.x0}`)
          path.setAttribute('class', 'base-tl-dep')
          svg.append(path)
        }
      }
      lanes.append(svg as unknown as HTMLElement)
    }
    this.names.replaceChildren(...names)
    this.canvas.replaceChildren(head, lanes)
    if (!visible.length) this.canvas.append(h('div', { class: 'base-hint' }, 'Aucune ligne datée dans cette période.'))
  }

  /** Glisser pour deplacer ; le bord droit pour changer la fin. */
  private draggable(bar: HTMLElement, row: QueryRow, px: number): void {
    const grip = h('span', { class: 'base-tl-grip', title: 'Changer la fin' })
    bar.append(grip)
    const begin = (e: MouseEvent, resize: boolean) => {
      e.preventDefault()
      e.stopPropagation()
      const x = e.clientX
      const left = bar.offsetLeft, w = bar.offsetWidth
      let delta = 0
      const move = (ev: MouseEvent) => {
        delta = Math.round((ev.clientX - x) / px)
        if (resize) bar.style.width = `${Math.max(px, w + delta * px)}px`
        else bar.style.left = `${left + delta * px}px`
      }
      const up = () => {
        window.removeEventListener('mousemove', move)
        window.removeEventListener('mouseup', up)
        if (delta) this.change(row, delta, resize)
      }
      window.addEventListener('mousemove', move)
      window.addEventListener('mouseup', up)
    }
    bar.addEventListener('mousedown', e => begin(e, false))
    grip.addEventListener('mousedown', e => begin(e, true))
  }

  /** Deplace une ligne de `delta` jours, ou change sa fin. */
  change(row: QueryRow, delta: number, resize: boolean): void {
    const v = this.host.valueOf(row, this.opts.dateBy)
    if (typeof v !== 'string') return
    if (this.opts.endBy) {
      const e = this.host.valueOf(row, this.opts.endBy)
      const end = typeof e === 'string' && e ? e : v
      if (!resize) this.host.edit(row, this.opts.dateBy, shiftDate(v, delta) as PropertyValue)
      this.host.edit(row, this.opts.endBy, shiftDate(end, delta) as PropertyValue)
      return
    }
    if (!resize) { this.host.edit(row, this.opts.dateBy, shiftDate(v, delta) as PropertyValue); return }
    const { start, end } = splitDateRange(v)
    const s = parseDay(start)
    const newEnd = shiftDate(end ?? start, delta)
    const e = parseDay(newEnd)
    if (!s || !e) return
    this.host.edit(row, this.opts.dateBy, (e > s ? `${start}/${newEnd}` : start) as PropertyValue)
  }
}
