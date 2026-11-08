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
