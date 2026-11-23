// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Largeur des colonnes d'un tableau Markdown. Elle s'ecrit dans la ligne des
// tirets, comme le fait Pandoc : chaque colonne a autant de tirets que sa part
// de la largeur (`|------|------------|` : un tiers, deux tiers). Le fichier
// reste un tableau Markdown ordinaire. Des tirets tous egaux (`|---|---|`) :
// pas de largeur imposee, le tableau se regle seul.

import { tableCells, tableLine } from './TableRows'

/** Nombre de tirets pour toute la largeur du tableau. */
const DASHES = 40

const DELIMITER_RE = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/

/** Des largeurs relatives en pourcentages entiers, qui font 100. */
export function toPercents(widths: readonly number[]): number[] {
  const total = widths.reduce((a, b) => a + b, 0) || 1
  const raw = widths.map(w => (w / total) * 100)
  const out = raw.map(Math.floor)
  // Le reste va aux colonnes les plus proches de l'entier superieur.
  let rest = 100 - out.reduce((a, b) => a + b, 0)
  const order = raw.map((v, i) => ({ i, frac: v - Math.floor(v) })).sort((a, b) => b.frac - a.frac)
  for (const { i } of order) { if (rest <= 0) break; out[i]++; rest-- }
  return out
}

const dashCount = (cell: string): number => (cell.match(/-/g) ?? []).length

/** Les largeurs (en %) d'une ligne de tirets, ou null si elles sont toutes egales. */
export function widthsOfDelimiter(line: string): number[] | null {
  const counts = tableCells(line).map(dashCount)
  if (counts.length < 2 || counts.every(c => c === counts[0])) return null
  return toPercents(counts)
}

/** Les largeurs (en %) de chaque tableau du texte, dans l'ordre. */
export function tableWidthsIn(text: string): (number[] | null)[] {
  const lines = text.split('\n')
  const out: (number[] | null)[] = []
  for (let i = 1; i < lines.length; i++) {
    const prev = lines[i - 1].replace(/^(\s*>\s?)+/, '')
    const line = lines[i].replace(/^(\s*>\s?)+/, '')
    if (prev.includes('|') && DELIMITER_RE.test(line) && line.includes('-')) out.push(widthsOfDelimiter(line))
  }
  return out
}

/** Le tableau avec de nouvelles largeurs (en %), alignements gardes. */
export function withTableWidths(source: string, percents: readonly number[]): string {
  const lines = source.split('\n')
  const i = lines.findIndex((l, n) => n > 0 && DELIMITER_RE.test(l) && l.includes('-'))
  if (i < 0) return source
  const cells = tableCells(lines[i])
  const next = cells.map((cell, c) => {
    const p = percents[c] ?? 0
    const n = Math.max(3, Math.round((p * DASHES) / 100))
    const left = cell.trim().startsWith(':') ? ':' : ''
    const right = cell.trim().endsWith(':') ? ':' : ''
    return `${left}${'-'.repeat(n)}${right}`
  })
  lines[i] = tableLine(next)
  return lines.join('\n')
}

/** Donne a un tableau rendu ses largeurs (colonnes fixes). */
export function setTableWidths(table: HTMLTableElement, percents: readonly number[] | null): void {
  table.querySelector(':scope > colgroup.plume-table-cols')?.remove()
  if (!percents) { table.style.tableLayout = ''; return }
  const group = document.createElement('colgroup')
  group.className = 'plume-table-cols'
  for (const p of percents) {
    const col = document.createElement('col')
    col.style.width = `${p}%`
    group.appendChild(col)
  }
  table.insertBefore(group, table.firstChild)
  table.style.tableLayout = 'fixed'
}

/** Les tableaux rendus de `root` prennent les largeurs ecrites dans `text`. */
export function applyTableWidths(root: HTMLElement, text: string): void {
  const tables = Array.from(root.querySelectorAll('table'))
  if (tables.length === 0) return
  const widths = tableWidthsIn(text)
  tables.forEach((t, i) => {
    const w = widths[i]
    if (w && w.length === (t.rows[0]?.cells.length ?? 0)) setTableWidths(t, w)
  })
}

/**
 * Poignees sur les bords des colonnes d'un tableau rendu : on tire, les deux
 * colonnes voisines changent de largeur ; au lacher, `commit` recoit les
 * pourcentages. Double clic : largeurs automatiques (null).
 */
export function tableResizers(box: HTMLElement, commit: (percents: number[] | null) => void): void {
  const table = box.querySelector('table')
  const head = table?.rows[0]
  if (!table || !head || head.cells.length < 2) return
  const bars: HTMLElement[] = []
  const layout = () => {
    const origin = box.getBoundingClientRect()
    const rect = table.getBoundingClientRect()
    const cells = Array.from(head.cells)
    bars.forEach((bar, i) => {
      const edge = cells[i].getBoundingClientRect().right
      bar.style.left = `${edge - origin.left - 4}px`
      bar.style.top = `${rect.top - origin.top}px`
      bar.style.height = `${rect.height}px`
    })
  }
  for (let i = 0; i < head.cells.length - 1; i++) {
    const bar = document.createElement('div')
    bar.className = 'plume-table-resizer'
    bar.dataset.testid = 'table-resizer'
    bar.title = 'Glisser pour changer la largeur (double clic : automatique)'
    bar.addEventListener('mousedown', e => { e.preventDefault(); e.stopPropagation() })
    bar.addEventListener('dblclick', e => { e.preventDefault(); e.stopPropagation(); commit(null) })
    bar.addEventListener('pointerdown', down => {
      if (down.button !== 0) return
      down.preventDefault()
      down.stopPropagation()
      bar.setPointerCapture?.(down.pointerId)
      const widths = Array.from(head.cells).map(c => c.getBoundingClientRect().width)
      const pair = widths[i] + widths[i + 1]
      const startX = down.clientX
      box.dataset.plumeEditing = '1'
      box.classList.add('plume-table-resizing')
      let percents = toPercents(widths)
      setTableWidths(table, percents)
      const move = (ev: PointerEvent) => {
        const min = Math.max(24, pair * 0.08)
        const left = Math.max(min, Math.min(pair - min, widths[i] + ev.clientX - startX))
        const next = [...widths]
        next[i] = left
        next[i + 1] = pair - left
        percents = toPercents(next)
        setTableWidths(table, percents)
        layout()
      }
      const up = () => {
        bar.removeEventListener('pointermove', move)
        bar.removeEventListener('pointerup', up)
        bar.removeEventListener('pointercancel', up)
        box.classList.remove('plume-table-resizing')
        delete box.dataset.plumeEditing
        commit(percents)
      }
      bar.addEventListener('pointermove', move)
      bar.addEventListener('pointerup', up)
      bar.addEventListener('pointercancel', up)
    })
    bars.push(bar)
    box.appendChild(bar)
  }
  box.addEventListener('mouseenter', layout)
  requestAnimationFrame(layout)
}

/** Largeurs automatiques : tous les tirets egaux, alignements gardes. */
export function withoutTableWidths(source: string): string {
  const lines = source.split('\n')
  const i = lines.findIndex((l, n) => n > 0 && DELIMITER_RE.test(l) && l.includes('-'))
  if (i < 0) return source
  lines[i] = tableLine(tableCells(lines[i]).map(c => `${c.trim().startsWith(':') ? ':' : ''}---${c.trim().endsWith(':') ? ':' : ''}`))
  return lines.join('\n')
}
