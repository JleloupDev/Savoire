// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Metriques au format texte Prometheus (version 0.0.4), ecrites a la main :
// compteurs, jauges, histogrammes, et quantiles sur une fenetre glissante
// (p50/p95 lisibles sans PromQL). Aucune dependance.

export type Labels = Record<string, string | number>

function escapeLabel(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"')
}

export function labelText(labels: Labels | undefined): string {
  if (!labels) return ''
  const keys = Object.keys(labels)
  if (!keys.length) return ''
  return `{${keys.map(k => `${k}="${escapeLabel(String(labels[k]))}"`).join(',')}}`
}

function num(v: number): string {
  if (Number.isNaN(v)) return 'NaN'
  if (v === Infinity) return '+Inf'
  if (v === -Infinity) return '-Inf'
  return String(v)
}

/** Une famille de metriques a ecrire. */
export interface Family {
  name: string
  help: string
  type: 'counter' | 'gauge' | 'histogram' | 'summary'
  samples: { suffix?: string; labels?: Labels; value: number }[]
}

export function render(families: readonly Family[]): string {
  const out: string[] = []
  for (const f of families) {
    out.push(`# HELP ${f.name} ${f.help.replace(/\\/g, '\\\\').replace(/\n/g, '\\n')}`)
    out.push(`# TYPE ${f.name} ${f.type}`)
    for (const s of f.samples) out.push(`${f.name}${s.suffix ?? ''}${labelText(s.labels)} ${num(s.value)}`)
  }
  return out.join('\n') + '\n'
}

/** Compteur a etiquettes. */
export class Counter {
  private readonly values = new Map<string, { labels: Labels; value: number }>()

  constructor(readonly name: string, readonly help: string) {}

  inc(labels: Labels = {}, n = 1): void {
    const key = labelText(labels)
    const cur = this.values.get(key)
    if (cur) cur.value += n
    else this.values.set(key, { labels, value: n })
  }

  get(labels: Labels = {}): number {
    return this.values.get(labelText(labels))?.value ?? 0
  }

  family(): Family {
    return { name: this.name, help: this.help, type: 'counter', samples: [...this.values.values()].map(v => ({ labels: v.labels, value: v.value })) }
  }
}

const DEFAULT_BUCKETS = [0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10]

/** Histogramme (secondes) + quantiles sur fenetre glissante. */
export class Histogram {
  private readonly series = new Map<string, { labels: Labels; counts: number[]; sum: number; count: number; window: Float64Array; times: Float64Array; next: number; filled: number }>()

  constructor(
    readonly name: string,
    readonly help: string,
    private readonly buckets = DEFAULT_BUCKETS,
    private readonly windowSize = 2048,
    private readonly windowMs = 5 * 60_000,
  ) {}

  observe(labels: Labels, seconds: number, now = Date.now()): void {
    const key = labelText(labels)
    let s = this.series.get(key)
    if (!s) {
      s = { labels, counts: new Array(this.buckets.length).fill(0), sum: 0, count: 0, window: new Float64Array(this.windowSize), times: new Float64Array(this.windowSize), next: 0, filled: 0 }
      this.series.set(key, s)
    }
    for (let i = 0; i < this.buckets.length; i++) if (seconds <= this.buckets[i]!) s.counts[i]!++
    s.sum += seconds
    s.count++
    s.window[s.next] = seconds
    s.times[s.next] = now
    s.next = (s.next + 1) % this.windowSize
    s.filled = Math.min(this.windowSize, s.filled + 1)
  }

  /** Quantiles sur la fenetre (dernieres minutes) ; undefined sans mesure. */
  quantiles(labels: Labels, qs: readonly number[], now = Date.now()): number[] | undefined {
    const s = this.series.get(labelText(labels))
    return s ? this.windowQuantiles(s, qs, now) : undefined
  }

  private windowQuantiles(s: { window: Float64Array; times: Float64Array; filled: number }, qs: readonly number[], now: number): number[] | undefined {
    const vals: number[] = []
    for (let i = 0; i < s.filled; i++) if (now - s.times[i]! <= this.windowMs) vals.push(s.window[i]!)
    if (!vals.length) return undefined
    vals.sort((a, b) => a - b)
    return qs.map(q => vals[Math.min(vals.length - 1, Math.max(0, Math.ceil(q * vals.length) - 1))]!)
  }

  families(quantileName: string, quantileHelp: string, now = Date.now()): Family[] {
    const hist: Family = { name: this.name, help: this.help, type: 'histogram', samples: [] }
    const quant: Family = { name: quantileName, help: quantileHelp, type: 'gauge', samples: [] }
    for (const s of this.series.values()) {
      for (let i = 0; i < this.buckets.length; i++) hist.samples.push({ suffix: '_bucket', labels: { ...s.labels, le: this.buckets[i]! }, value: s.counts[i]! })
      hist.samples.push({ suffix: '_bucket', labels: { ...s.labels, le: '+Inf' }, value: s.count })
      hist.samples.push({ suffix: '_sum', labels: s.labels, value: s.sum })
      hist.samples.push({ suffix: '_count', labels: s.labels, value: s.count })
      const q = this.windowQuantiles(s, [0.5, 0.95, 0.99], now)
      if (q) {
        quant.samples.push({ labels: { ...s.labels, quantile: '0.5' }, value: q[0]! })
        quant.samples.push({ labels: { ...s.labels, quantile: '0.95' }, value: q[1]! })
        quant.samples.push({ labels: { ...s.labels, quantile: '0.99' }, value: q[2]! })
      }
    }
    return [hist, quant]
  }
}

export function gauge(name: string, help: string, samples: Family['samples']): Family {
  return { name, help, type: 'gauge', samples }
}

export function counterFamily(name: string, help: string, samples: Family['samples']): Family {
  return { name, help, type: 'counter', samples }
}
