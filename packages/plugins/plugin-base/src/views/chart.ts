// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Graphique d'une base : une barre (ou un point, une part) par valeur d'une
// propriete ; la hauteur est le nombre de lignes, ou la somme, la moyenne,
// le minimum ou le maximum d'une propriete nombre. Le nombre de lignes vient
// du moteur (groupes) ; les autres calculs se font sur les lignes lues.
// Dessin en SVG, couleurs des options quand il y en a.
import type { PropertyOption, PropertyType, PropertyValue, Query, QueryField, QueryRow } from '@savoire/plugin-api'
import { h } from '../dom'
import { fetchBaseRows } from '../queryBlock'
import { groupId, groupLabel, orderGroups, type DateGrouping } from '../groups'
import type { ChartKind } from '../manifest'
import type { LayoutHost } from './host'

export interface ChartSpec {
  /** Axe : la propriete, son type, son champ (une date : par mois...). */
  key: string
  type: PropertyType
  field: QueryField
  options: PropertyOption[]
  dateGroup?: DateGrouping
  kind: ChartKind
  /** Mesure : '' = nombre de lignes. */
  y: string
  calc: 'sum' | 'mean' | 'min' | 'max'
  yLabel?: string
}

export interface ChartPoint { key: PropertyValue; label: string; value: number; color?: string }

const PALETTE = ['#7c6cf2', '#3aa0e8', '#36b37e', '#f0a830', '#e5594f', '#c46bd6', '#4fc1c9', '#9aa0a6']
const COLORS: Record<string, string> = {
  gray: '#9aa0a6', brown: '#a0704a', orange: '#ec8c28', yellow: '#dcb428', green: '#3caa5a', blue: '#3c82e6', purple: '#965adc', pink: '#e15aa0', red: '#e14646',
}

/** Les points d'un graphique a partir des lignes (mesure autre que le nombre). */
export function chartPoints(rows: QueryRow[], spec: ChartSpec, valueOf: (row: QueryRow, key: string) => PropertyValue | undefined, xOf: (row: QueryRow) => PropertyValue | undefined): Map<string, { key: PropertyValue; values: number[] }> {
  const out = new Map<string, { key: PropertyValue; values: number[] }>()
  for (const row of rows) {
    const x = xOf(row)
    const keys: PropertyValue[] = x === undefined || x === null || x === '' || (Array.isArray(x) && !x.length) ? [null] : Array.isArray(x) ? x : [x]
    const y = valueOf(row, spec.y)
    for (const k of keys) {
      const id = groupId(k)
      const p = out.get(id) ?? { key: k, values: [] }
      if (typeof y === 'number' && Number.isFinite(y)) p.values.push(y)
      out.set(id, p)
    }
  }
  return out
}

function measure(values: number[], calc: ChartSpec['calc']): number {
  if (!values.length) return 0
  switch (calc) {
    case 'sum': return values.reduce((a, b) => a + b, 0)
    case 'mean': return values.reduce((a, b) => a + b, 0) / values.length
    case 'min': return Math.min(...values)
    case 'max': return Math.max(...values)
  }
}

export class BaseChart {
  readonly el: HTMLElement
  private readonly svgBox: HTMLElement
  private readonly legend: HTMLElement
  private query: Query | null = null
  private spec: ChartSpec | null = null
  private stop: (() => void) | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  points: ChartPoint[] = []

  constructor(private readonly host: LayoutHost) {
    this.svgBox = h('div', { class: 'base-chart-svg' })
    this.legend = h('div', { class: 'base-chart-legend', 'data-testid': 'base-chart-legend' })
    this.el = h('div', { class: 'base-chart', 'data-testid': 'base-chart' }, this.svgBox, this.legend)
  }

  setQuery(query: Query, spec: ChartSpec, force = false): void {
    if (!force && this.query && JSON.stringify([this.query, this.spec]) === JSON.stringify([query, spec])) return
    this.destroy()
    this.query = query
    this.spec = spec
    if (!spec.key) { this.svgBox.replaceChildren(h('div', { class: 'base-hint' }, 'Choisissez la propriété de l’axe (réglages de la vue).')); return }
    if (!spec.y) {
      this.stop = this.host.engine.watch({ ...query, groupBy: spec.field, limit: 1 }, r => {
        this.points = this.order((r.groups ?? []).filter(g => !Array.isArray(g.key)).map(g => ({ key: g.key, value: g.count })))
        this.render()
      })
      return
    }
    // Mesure d'une propriete : on relit les lignes a chaque changement.
    const run = async () => {
      const { rows } = await fetchBaseRows(this.host.engine, query)
      if (this.query !== query) return
      const xKey = spec.key
      const xOf = (row: QueryRow) => 'formula' in spec.field ? this.dateKey(row) : this.host.valueOf(row, xKey)
      const groups = chartPoints(rows, spec, this.host.valueOf, xOf)
      this.points = this.order([...groups.values()].map(g => ({ key: g.key, value: Math.round(measure(g.values, spec.calc) * 100) / 100 })))
      this.render()
    }
    this.stop = this.host.engine.watch({ ...query, limit: 1 }, () => {
      if (this.timer) clearTimeout(this.timer)
      this.timer = setTimeout(() => { this.timer = null; void run().catch(err => console.warn('[plugin-base] graphique', err)) }, 80)
    })
  }

  /** Groupe d'une date selon dateGroup, calcule comme le moteur (groups.ts). */
  private dateKey(row: QueryRow): PropertyValue {
    const v = this.host.valueOf(row, this.spec!.key)
    if (typeof v !== 'string') return null
    const day = v.slice(0, 10)
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day)
    if (!m) return null
    switch (this.spec!.dateGroup) {
      case 'year': return m[1]
      case 'month': return `${m[1]}-${m[2]}`
      case 'week': {
        const t = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])))
        t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7))
        const w = Math.ceil(((t.getTime() - Date.UTC(t.getUTCFullYear(), 0, 1)) / 86_400_000 + 1) / 7)
        return `${t.getUTCFullYear()}-S${String(w).padStart(2, '0')}`
      }
      default: return day
    }
  }

  private order(points: { key: PropertyValue; value: number }[]): ChartPoint[] {
    const spec = this.spec!
    const byId = new Map(points.map(p => [groupId(p.key), p]))
    let n = 0
    return orderGroups(points.map(p => p.key), spec.type, spec.options).map(k => {
      const p = byId.get(groupId(k))!
      const color = COLORS[spec.options.find(o => o.value === k)?.color ?? ''] ?? PALETTE[n++ % PALETTE.length]
      return { key: k, value: p.value, color, label: groupLabel(k, spec.type, spec.dateGroup, this.host.cells().members) }
    })
  }

  refresh(): void {
    this.render()
  }

  destroy(): void {
    this.stop?.()
    this.stop = null
    if (this.timer) { clearTimeout(this.timer); this.timer = null }
    this.query = null
    this.points = []
    this.svgBox.replaceChildren()
    this.legend.replaceChildren()
  }

  private render(): void {
    const spec = this.spec
    if (!spec) return
    const pts = this.points
    const ns = 'http://www.w3.org/2000/svg'
    const el = <K extends string>(tag: K, attrs: Record<string, string | number>) => {
      const e = document.createElementNS(ns, tag)
      for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v))
      return e
    }
    const W = 640, H = 300, P = 36
    const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, class: 'base-chart-drawing', role: 'img' })
    const max = Math.max(1, ...pts.map(p => p.value))
    const fmt = (v: number) => v.toLocaleString('fr-FR', { maximumFractionDigits: 2 })
    if (!pts.length) {
      this.svgBox.replaceChildren(h('div', { class: 'base-hint' }, 'Aucune donnée.'))
      this.legend.replaceChildren()
      return
    }
    if (spec.kind === 'donut') {
      const total = pts.reduce((a, p) => a + p.value, 0) || 1
      const cx = W / 2, cy = H / 2, r = 110, inner = 62
      let angle = -Math.PI / 2
      for (const p of pts) {
        const a = (p.value / total) * Math.PI * 2
        const large = a > Math.PI ? 1 : 0
        const x0 = cx + r * Math.cos(angle), y0 = cy + r * Math.sin(angle)
        const x1 = cx + r * Math.cos(angle + a - 1e-6), y1 = cy + r * Math.sin(angle + a - 1e-6)
        const xi1 = cx + inner * Math.cos(angle + a - 1e-6), yi1 = cy + inner * Math.sin(angle + a - 1e-6)
        const xi0 = cx + inner * Math.cos(angle), yi0 = cy + inner * Math.sin(angle)
        const path = el('path', { d: `M${x0},${y0} A${r},${r} 0 ${large} 1 ${x1},${y1} L${xi1},${yi1} A${inner},${inner} 0 ${large} 0 ${xi0},${yi0} Z`, fill: p.color ?? PALETTE[0], 'data-testid': 'base-chart-mark' })
        const title = el('title', {})
        title.textContent = `${p.label} : ${fmt(p.value)}`
        path.append(title)
        svg.append(path)
        angle += a
      }
      const t = el('text', { x: cx, y: cy + 6, 'text-anchor': 'middle', class: 'base-chart-total' })
      t.textContent = fmt(pts.reduce((a, p) => a + p.value, 0))
      svg.append(t)
    } else if (spec.kind === 'hbar') {
      const bh = Math.min(28, (H - 10) / pts.length - 6)
      const left = 120
      pts.forEach((p, i) => {
        const y = 5 + i * (bh + 6)
        const w = (p.value / max) * (W - left - 50)
        const label = el('text', { x: left - 6, y: y + bh / 2 + 4, 'text-anchor': 'end', class: 'base-chart-label' })
        label.textContent = p.label.length > 16 ? `${p.label.slice(0, 15)}…` : p.label
        const bar = el('rect', { x: left, y, width: Math.max(1, w), height: bh, rx: 3, fill: p.color ?? PALETTE[0], 'data-testid': 'base-chart-mark' })
        const v = el('text', { x: left + w + 4, y: y + bh / 2 + 4, class: 'base-chart-value' })
        v.textContent = fmt(p.value)
        svg.append(label, bar, v)
      })
    } else {
      const step = (W - P * 2) / pts.length
      const bw = Math.min(56, step * 0.7)
      const y = (v: number) => H - P - (v / max) * (H - P * 2)
      svg.append(el('line', { x1: P, x2: W - P, y1: H - P, y2: H - P, class: 'base-chart-axis' }))
      if (spec.kind === 'line') {
        const d = pts.map((p, i) => `${i ? 'L' : 'M'}${P + step * i + step / 2},${y(p.value)}`).join(' ')
        svg.append(el('path', { d, fill: 'none', class: 'base-chart-line' }))
      }
      pts.forEach((p, i) => {
        const x = P + step * i + step / 2
        const mark = spec.kind === 'line'
          ? el('circle', { cx: x, cy: y(p.value), r: 4, fill: p.color ?? PALETTE[0], 'data-testid': 'base-chart-mark' })
          : el('rect', { x: x - bw / 2, y: y(p.value), width: bw, height: Math.max(1, H - P - y(p.value)), rx: 3, fill: p.color ?? PALETTE[0], 'data-testid': 'base-chart-mark' })
        const v = el('text', { x, y: y(p.value) - 5, 'text-anchor': 'middle', class: 'base-chart-value' })
        v.textContent = fmt(p.value)
        const label = el('text', { x, y: H - P + 16, 'text-anchor': 'middle', class: 'base-chart-label' })
        label.textContent = p.label.length > 12 ? `${p.label.slice(0, 11)}…` : p.label
        svg.append(mark, v, label)
      })
    }
    this.svgBox.replaceChildren(svg as unknown as Node)
    this.legend.replaceChildren(...pts.map(p => {
      const sw = h('span', { class: 'base-chart-swatch' })
      sw.style.background = p.color ?? PALETTE[0]
      return h('span', { class: 'base-chart-item', 'data-testid': 'base-chart-item' }, sw, `${p.label} : ${fmt(p.value)}`)
    }))
  }
}
