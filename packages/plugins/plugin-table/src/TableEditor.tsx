// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// TableEditor — react-data-grid + HyperFormula interactive table.
//

import React, { useState, useMemo, useRef, useCallback } from 'react'
import DataGrid, { type Column, type SortColumn, type RenderEditCellProps } from 'react-data-grid'
import 'react-data-grid/lib/styles.css'
import { HyperFormula } from 'hyperformula'
import type { TableData } from './gfm'

// ── Types ─────────────────────────────────────────────────────────────────

// Each grid row is a flat object: { __ri: "0", c0: "val", c1: "val", ... }
// __ri is the original (pre-sort) row index in rawData — needed to write back.
type GridRow = Record<string, string>

// ── Component ─────────────────────────────────────────────────────────────

interface TableEditorProps {
  initialData: TableData
  /** Called on every committed edit, debounced by the caller. */
  onChange: (data: TableData) => void
  /**
   * Hauteur de la grille en px. Sans valeur : elle suit le nombre de lignes,
   * jusqu'a `maxHeight` (puis defilement).
   */
  height?: number
  /** Hauteur maximale quand la grille suit ses lignes. Defaut : 560. */
  maxHeight?: number
  readOnly?: boolean
}

/** Hauteurs par defaut de react-data-grid (en-tete et lignes). */
const ROW_PX = 35

export function TableEditor({ initialData, onChange, height, maxHeight = 560, readOnly = false }: TableEditorProps) {
  const [headers, setHeaders] = useState<string[]>(initialData.headers)
  const [rawData, setRawData]  = useState<string[][]>(
    // Ensure every row has the right number of columns
    () => initialData.rows.map(r => {
      const row = [...r]
      while (row.length < initialData.headers.length) row.push('')
      return row.slice(0, initialData.headers.length)
    })
  )
  const [sortColumns, setSortColumns] = useState<readonly SortColumn[]>([])

  const hasFormulas = useMemo(
    () => rawData.some(row => row.some(cell => cell.startsWith('='))),
    [rawData],
  )

  // Keep a ref for rawData so renderEditCell always reads the latest value
  // without needing to re-create column definitions on every keystroke.
  const rawDataRef = useRef(rawData)
  rawDataRef.current = rawData

  // ── HyperFormula evaluation ──────────────────────────────────────────────
  const displayValues = useMemo<string[][]>(() => {
    if (rawData.length === 0 || rawData[0].length === 0) return rawData
    try {
      const hf = HyperFormula.buildFromArray(rawData, { licenseKey: 'gpl-v3' })
      return hf.getSheetValues(0).map(row =>
        row.map(v => (v === null || v === undefined ? '' : String(v)))
      )
    } catch {
      // If HF fails (e.g. circular reference), fall back to raw values
      return rawData.map(row => row.map(v => (v.startsWith('=') ? '#ERR' : v)))
    }
  }, [rawData])

  // ── Display rows (includes __ri for write-back) ──────────────────────────
  const displayRows = useMemo<GridRow[]>(() => {
    return displayValues.map((row, ri) => {
      const obj: GridRow = { __ri: String(ri) }
      row.forEach((val, ci) => { obj[`c${ci}`] = val })
      return obj
    })
  }, [displayValues])

  // ── Sorting ──────────────────────────────────────────────────────────────
  const sortedRows = useMemo<GridRow[]>(() => {
    if (!sortColumns.length) return displayRows
    return [...displayRows].sort((a, b) => {
      for (const { columnKey, direction } of sortColumns) {
        const aVal = a[columnKey] ?? ''
        const bVal = b[columnKey] ?? ''
        // Try numeric sort first
        const aNum = parseFloat(aVal)
        const bNum = parseFloat(bVal)
        const cmp = !isNaN(aNum) && !isNaN(bNum)
          ? aNum - bNum
          : aVal.localeCompare(bVal)
        if (cmp !== 0) return direction === 'ASC' ? cmp : -cmp
      }
      return 0
    })
  }, [displayRows, sortColumns])

  // ── Commit edit ──────────────────────────────────────────────────────────
  const commit = useCallback((newRaw: string[][], newHeaders: string[]) => {
    onChange({ headers: newHeaders, rows: newRaw })
  }, [onChange])

  function handleRowsChange(newSortedRows: GridRow[], { indexes }: { indexes: number[] }) {
    const newRaw = rawData.map(r => [...r])
    for (const idx of indexes) {
      const editedRow = newSortedRows[idx]
      const ri = parseInt(editedRow.__ri)
      if (ri < 0 || ri >= newRaw.length) continue
      headers.forEach((_, ci) => {
        const v = editedRow[`c${ci}`]
        if (v !== undefined) newRaw[ri][ci] = v
      })
    }
    setRawData(newRaw)
    commit(newRaw, headers)
  }

  // ── Column definitions ────────────────────────────────────────────────────
  const columns = useMemo<Column<GridRow>[]>(() => {
    return headers.map((h, ci) => ({
      key: `c${ci}`,
      name: h,
      resizable: true,
      sortable: !hasFormulas,
      editable: !readOnly,
      minWidth: 80,

      // Show computed value; formula cells get a subtle indicator
      renderCell({ row }) {
        const val = row[`c${ci}`] ?? ''
        const ri = parseInt(row.__ri)
        const raw = rawDataRef.current[ri]?.[ci] ?? ''
        const isFormula = raw.startsWith('=')
        return (
          <div style={{ paddingInline: 6, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: isFormula ? 'var(--accent,#8b5cf6)' : 'inherit' }}>
            {val}
          </div>
        )
      },

      // Editor shows the raw formula string for editing
      renderEditCell(props: RenderEditCellProps<GridRow>) {
        const ri = parseInt(props.row.__ri)
        const rawVal = rawDataRef.current[ri]?.[ci] ?? ''
        return (
          <FormulaInput
            initialValue={rawVal}
            onCommit={val => {
              props.onRowChange({ ...props.row, [`c${ci}`]: val }, true)
            }}
            onAbort={() => props.onClose(false)}
          />
        )
      },
    }))
  }, [headers, readOnly])

  // ── Add / remove rows ─────────────────────────────────────────────────────
  function addRow() {
    const newRow = Array(headers.length).fill('')
    const newRaw = [...rawData, newRow]
    setRawData(newRaw)
    commit(newRaw, headers)
  }

  function addColumn() {
    const newHeader = `Col ${headers.length + 1}`
    const newHeaders = [...headers, newHeader]
    const newRaw = rawData.map(r => [...r, ''])
    setHeaders(newHeaders)
    setRawData(newRaw)
    commit(newRaw, newHeaders)
  }

  function removeLastRow() {
    if (rawData.length === 0) return
    const newRaw = rawData.slice(0, -1)
    setRawData(newRaw)
    commit(newRaw, headers)
  }

  // Tout le tableau visible tant qu'il tient : on voit vraiment ses lignes.
  const gridHeight = height ?? Math.min(maxHeight, ROW_PX * (rawData.length + 1) + 2)

  // ── Render ───────────────────────────────────────────────────────────────
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div>
        <DataGrid
          columns={columns}
          rows={sortedRows}
          onRowsChange={handleRowsChange}
          sortColumns={sortColumns}
          onSortColumnsChange={setSortColumns}
          onCellKeyDown={(args, event) => {
            // Fleche bas sur la derniere ligne, ou Tab sur sa derniere case :
            // une nouvelle ligne, comme dans Notion.
            if (readOnly || args.mode !== 'SELECT') return
            const lastRow = args.rowIdx === sortedRows.length - 1
            const lastCol = args.column.idx === columns.length - 1
            if (lastRow && (event.key === 'ArrowDown' || (event.key === 'Tab' && !event.shiftKey && lastCol))) {
              event.preventGridDefault()
              event.preventDefault()
              addRow()
              // La nouvelle ligne est selectionnee, prete a etre remplie.
              const idx = event.key === 'Tab' ? 0 : args.column.idx
              setTimeout(() => args.selectCell({ rowIdx: args.rowIdx + 1, idx }), 0)
            }
          }}
          style={{ height: gridHeight, blockSize: gridHeight, colorScheme: 'dark' }}
          className="rdg-dark"
        />
        {!readOnly && (
          <button
            type="button"
            data-testid="table-add-row-bottom"
            onClick={addRow}
            style={{
              display: 'block', width: '100%', height: 30, padding: '0 10px', textAlign: 'left',
              fontSize: 12, fontFamily: 'inherit', cursor: 'pointer',
              background: 'transparent', color: 'var(--text-faint,#6c7086)',
              border: '1px solid var(--border,#3d3d5c)', borderTop: 'none', borderRadius: '0 0 4px 4px',
            }}
          >
            + Nouvelle ligne
          </button>
        )}
      </div>
      {!readOnly && (
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <TableBtn onClick={addColumn}>+ Colonne</TableBtn>
          <TableBtn onClick={removeLastRow} disabled={rawData.length === 0}>− Ligne</TableBtn>
          {hasFormulas && (
            <span style={{ fontSize: '10px', color: 'var(--text-faint,#555)', marginLeft: 4 }}>
              tri désactivé (formules)
            </span>
          )}
        </div>
      )}
    </div>
  )
}

// ── FormulaInput — inline cell editor ────────────────────────────────────

function FormulaInput({
  initialValue,
  onCommit,
  onAbort,
}: {
  initialValue: string
  onCommit: (val: string) => void
  onAbort: () => void
}) {
  const [val, setVal] = useState(initialValue)
  const ref = useRef<HTMLInputElement>(null)

  return (
    <input
      ref={ref}
      autoFocus
      value={val}
      onChange={e => setVal(e.target.value)}
      onBlur={() => onCommit(val)}
      onKeyDown={e => {
        if (e.key === 'Enter') { e.preventDefault(); onCommit(val) }
        if (e.key === 'Escape') { e.preventDefault(); onAbort() }
      }}
      style={{
        width: '100%',
        height: '100%',
        padding: '0 6px',
        border: 'none',
        outline: '2px solid var(--accent,#8b5cf6)',
        background: 'var(--bg,#181825)',
        color: 'var(--text,#ddd)',
        fontFamily: 'inherit',
        fontSize: 'inherit',
        boxSizing: 'border-box',
      }}
    />
  )
}

// ── Helper ────────────────────────────────────────────────────────────────

function TableBtn({ onClick, children, disabled }: {
  onClick: () => void
  children: React.ReactNode
  disabled?: boolean
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        padding: '2px 10px',
        fontSize: '11px',
        fontFamily: 'inherit',
        background: 'var(--bg-surface,#252535)',
        color: 'var(--text-muted,#aaa)',
        border: '1px solid var(--border,#3d3d5c)',
        borderRadius: 4,
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.4 : 1,
      }}
    >
      {children}
    </button>
  )
}
