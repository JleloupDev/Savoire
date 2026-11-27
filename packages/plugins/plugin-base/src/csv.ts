// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Texte <-> valeurs d'une base : CSV (export d'une vue, import de lignes),
// et texte colle dans une cellule (copier-coller depuis un tableur).
import type { PropertyType, PropertyValue } from '@savoire/plugin-api'

/** Une cellule CSV : entre guillemets si elle contient un separateur, un guillemet ou un saut de ligne. */
function quote(cell: string, sep: string): string {
  return /["\r\n]/.test(cell) || cell.includes(sep) ? `"${cell.replace(/"/g, '""')}"` : cell
}

/** Lignes -> CSV (RFC 4180), separateur virgule. */
export function toCsv(rows: string[][], sep = ','): string {
  return rows.map(r => r.map(c => quote(c, sep)).join(sep)).join('\r\n') + '\r\n'
}

/** Separateur le plus probable : celui qui revient le plus sur la premiere ligne (virgule, point-virgule, tabulation). */
function detectSeparator(text: string): string {
  const first = text.split(/\r?\n/, 1)[0] ?? ''
  const count = (c: string) => first.split(c).length - 1
  return [',', ';', '\t'].sort((a, b) => count(b) - count(a))[0]
}

/** CSV -> lignes. Guillemets doubles, sauts de ligne dans une cellule, BOM ignore. */
export function parseCsv(input: string, sep?: string): string[][] {
  const text = input.replace(/^﻿/, '')
  const s = sep ?? detectSeparator(text)
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++ } else quoted = false
      } else cell += c
      continue
    }
    if (c === '"' && cell === '') quoted = true
    else if (c === s) { row.push(cell); cell = '' }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++
      row.push(cell)
      rows.push(row)
      row = []
      cell = ''
    } else cell += c
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row) }
  return rows.filter(r => r.some(c => c.trim() !== ''))
}

const TRUE_RE = /^(true|vrai|oui|yes|x|1|☑|✓)$/i
const LIST_TYPES: ReadonlySet<string> = new Set(['multiselect', 'relation', 'files', 'aliases', 'tags'])

/** Un texte (CSV, presse-papiers) -> valeur du type de la propriete. Vide : null. */
export function parseCellText(type: PropertyType, text: string, multiple = false): PropertyValue {
  const t = text.trim()
  if (!t) return null
  switch (type) {
    case 'number': {
      const n = Number(t.replace(/\s/g, '').replace(',', '.').replace(/[€$£%]/g, ''))
      return Number.isFinite(n) ? n : t
    }
    case 'checkbox': return TRUE_RE.test(t)
    case 'person': return multiple ? t.split(',').map(x => x.trim()).filter(Boolean) : t
    case 'link': return t.startsWith('[[') || /^https?:\/\//i.test(t) ? t : `[[${t}]]`
  }
  if (LIST_TYPES.has(type)) {
    const items = t.split(',').map(x => x.trim()).filter(Boolean)
    return type === 'multiselect' ? items : items.map(x => x.startsWith('[[') || /^https?:\/\//i.test(x) ? x : `[[${x}]]`)
  }
  return t
}

/** Une valeur -> texte d'une cellule CSV. */
export function cellCsv(v: PropertyValue | undefined): string {
  if (v === null || v === undefined) return ''
  if (Array.isArray(v)) return v.join(', ')
  return String(v)
}
