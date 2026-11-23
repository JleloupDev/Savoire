// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Tableau Markdown d'une note : ajouter une ligne a la fin, comme le « + »
// sous un tableau de Notion. Le tableau rendu porte un bouton ; un clic ajoute
// une ligne vide sous la derniere et place le curseur dans sa premiere case.

import type { EditorState, TransactionSpec } from '@codemirror/state'
import { syntaxTree } from '@codemirror/language'

/** Nombre de colonnes d'une ligne de tableau (`| a | b |` ou `a | b`). */
export function tableColumnCount(line: string): number {
  let text = line.trim()
  if (text.startsWith('|')) text = text.slice(1)
  if (text.endsWith('|') && !text.endsWith('\\|')) text = text.slice(0, -1)
  // Les barres echappees (\|) restent dans la case.
  return Math.max(1, text.split(/(?<!\\)\|/).length)
}

/** Le tableau qui contient `pos` (ou commence a `pos`) : ses bornes. */
export function tableAt(state: EditorState, pos: number): { from: number; to: number } | null {
  const tree = syntaxTree(state)
  for (const side of [1, -1] as const) {
    for (let node: ReturnType<typeof tree.resolveInner> | null = tree.resolveInner(pos, side); node; node = node.parent) {
      if (node.name === 'Table') return { from: node.from, to: node.to }
    }
  }
  return null
}

/**
 * La transaction qui ajoute une ligne vide a la fin du tableau situe a `pos`.
 * Null si `pos` n'est pas dans un tableau.
 */
export function appendTableRow(state: EditorState, pos: number): TransactionSpec | null {
  const table = tableAt(state, pos)
  if (!table) return null
  const header = state.doc.lineAt(table.from).text
  const columns = tableColumnCount(header)
  const last = state.doc.lineAt(table.to)
  const row = '|' + '   |'.repeat(columns)
  const insert = `\n${row}`
  return {
    changes: { from: last.to, insert },
    // Dans la premiere case : le tableau passe en edition, pret a etre rempli.
    selection: { anchor: last.to + 3 },
    scrollIntoView: true,
    userEvent: 'input',
  }
}

// ── Lignes et colonnes ──────────────────────────────────────────────────────
//
// Les lignes « affichees » d'un tableau : 0 pour l'en-tete, 1 pour la
// premiere ligne du corps (la ligne des tirets n'en est pas une). Chaque
// operation rend le nouveau texte du tableau, ou le meme s'il n'y a rien a
// faire (deplacer la premiere ligne vers le haut).

/** Les cases d'une ligne de tableau, barres echappees comprises. */
export function tableCells(line: string): string[] {
  let text = line.trim()
  if (text.startsWith('|')) text = text.slice(1)
  if (text.endsWith('|') && !text.endsWith('\\|')) text = text.slice(0, -1)
  return text.split(/(?<!\\)\|/).map(c => c.trim())
}

export function tableLine(cells: readonly string[]): string {
  return `| ${cells.join(' | ')} |`
}

/**
 * Les tirets d'une nouvelle colonne : la largeur moyenne si le tableau a des
 * largeurs (tirets inegaux, voir TableWidths), sinon `---`.
 */
export function newColumnDelimiter(delimiters: readonly string[]): string {
  const counts = delimiters.map(d => (d.match(/-/g) ?? []).length)
  if (counts.length === 0 || counts.every(c => c === counts[0])) return '---'
  return '-'.repeat(Math.max(3, Math.round(counts.reduce((a, b) => a + b, 0) / counts.length)))
}

interface Grid { header: string[]; align: string[]; body: string[][] }

function gridOf(source: string): Grid | null {
  const lines = source.split('\n').filter(l => l.trim())
  if (lines.length < 2) return null
  const header = tableCells(lines[0])
  const width = header.length
  const pad = (cells: string[], fill: string) => {
    const out = cells.slice(0, width)
    while (out.length < width) out.push(fill)
    return out
  }
  return {
    header,
    align: pad(tableCells(lines[1]), '---'),
    body: lines.slice(2).map(l => pad(tableCells(l), '')),
  }
}

function textOf(g: Grid): string {
  return [g.header, g.align, ...g.body].map(tableLine).join('\n')
}

/** Nombre de lignes du corps et de colonnes. */
export function tableSize(source: string): { rows: number; cols: number } {
  const g = gridOf(source)
  return g ? { rows: g.body.length, cols: g.header.length } : { rows: 0, cols: 0 }
}

/** Une ligne vide au-dessus (`below` faux) ou au-dessous de `row`. Pas au-dessus de l'en-tete. */
export function insertTableRow(source: string, row: number, below: boolean): string {
  const g = gridOf(source)
  if (!g || (row === 0 && !below)) return source
  const at = Math.max(0, Math.min(g.body.length, below ? row : row - 1))
  g.body.splice(at, 0, g.header.map(() => ''))
  return textOf(g)
}

/** Retire une ligne du corps (l'en-tete reste). */
export function deleteTableRow(source: string, row: number): string {
  const g = gridOf(source)
  if (!g || row < 1 || row > g.body.length) return source
  g.body.splice(row - 1, 1)
  return textOf(g)
}

/** Echange une ligne du corps avec sa voisine du dessus (-1) ou du dessous (1). */
export function moveTableRow(source: string, row: number, dir: 1 | -1): string {
  const g = gridOf(source)
  const to = row + dir
  if (!g || row < 1 || to < 1 || row > g.body.length || to > g.body.length) return source
  const [moved] = g.body.splice(row - 1, 1)
  g.body.splice(to - 1, 0, moved)
  return textOf(g)
}

/** Une colonne vide a gauche (`right` faux) ou a droite de `col`. */
export function insertTableColumn(source: string, col: number, right: boolean): string {
  const g = gridOf(source)
  if (!g) return source
  const at = Math.max(0, Math.min(g.header.length, right ? col + 1 : col))
  g.header.splice(at, 0, '')
  g.align.splice(at, 0, newColumnDelimiter(g.align))
  for (const r of g.body) r.splice(at, 0, '')
  return textOf(g)
}

/** Retire une colonne (il en reste toujours une). */
export function deleteTableColumn(source: string, col: number): string {
  const g = gridOf(source)
  if (!g || g.header.length < 2 || col < 0 || col >= g.header.length) return source
  for (const r of [g.header, g.align, ...g.body]) r.splice(col, 1)
  return textOf(g)
}

/** Echange une colonne avec sa voisine de gauche (-1) ou de droite (1), alignement compris. */
export function moveTableColumn(source: string, col: number, dir: 1 | -1): string {
  const g = gridOf(source)
  const to = col + dir
  if (!g || col < 0 || to < 0 || col >= g.header.length || to >= g.header.length) return source
  for (const r of [g.header, g.align, ...g.body]) [r[col], r[to]] = [r[to], r[col]]
  return textOf(g)
}
