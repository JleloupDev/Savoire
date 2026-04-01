// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// GFM table parser/serializer.
//
// Format on disk (.table files and inline Markdown tables):
//   | Col A | Col B | Total      |
//   |-------|-------|------------|
//   | Apple | 10    | =B2*0.5    |
//   |       |       | =SUM(C2:C3)|
//
//
// Row/column references use 1-based notation matching HyperFormula's A1 style:
//   A1 = first data row, first column (header row excluded from addressing).

export interface TableData {
  headers: string[]
  rows: string[][]    // raw cell values; formulas stored as "=..." strings
}

// ── Parse ─────────────────────────────────────────────────────────────────

function splitCells(line: string): string[] {
  return line
    .replace(/^\||\|$/g, '')   // strip leading/trailing pipe
    .split('|')
    .map(c => c.trim())
}

function isSeparatorRow(cells: string[]): boolean {
  return cells.every(c => /^:?-+:?$/.test(c))
}

export function parseGfmTable(markdown: string): TableData {
  const lines = markdown.trim().split('\n').filter(l => l.trim().length > 0)
  if (lines.length < 2) return { headers: [], rows: [] }

  const headers = splitCells(lines[0])
  const dataLines = lines.slice(1).filter(l => !isSeparatorRow(splitCells(l)))
  const colCount  = headers.length

  const rows = dataLines.map(l => {
    const cells = splitCells(l)
    // Pad or truncate to match header column count
    while (cells.length < colCount) cells.push('')
    return cells.slice(0, colCount)
  })

  return { headers, rows }
}

// ── Serialize ─────────────────────────────────────────────────────────────

function colWidth(data: TableData, col: number): number {
  const vals = [
    data.headers[col] ?? '',
    ...data.rows.map(r => r[col] ?? ''),
  ]
  return Math.max(3, ...vals.map(v => v.length))
}

export function serializeGfmTable(data: TableData): string {
  const { headers, rows } = data
  if (headers.length === 0) return ''

  const widths = headers.map((_, i) => colWidth(data, i))
  const pad = (s: string, w: number) => s + ' '.repeat(Math.max(0, w - s.length))

  const headerRow = '| ' + headers.map((h, i) => pad(h, widths[i])).join(' | ') + ' |'
  const sepRow    = '| ' + widths.map(w => '-'.repeat(w)).join(' | ') + ' |'
  const dataRows  = rows.map(
    r => '| ' + r.map((c, i) => pad(c, widths[i])).join(' | ') + ' |'
  )

  return [headerRow, sepRow, ...dataRows].join('\n')
}

// ── Default template ──────────────────────────────────────────────────────

export const DEFAULT_TABLE: TableData = {
  headers: ['Col A', 'Col B', 'Col C'],
  rows: [
    ['', '', ''],
    ['', '', ''],
  ],
}
