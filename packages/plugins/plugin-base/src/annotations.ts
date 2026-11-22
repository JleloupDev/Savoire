// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Revision dans une base : les cellules commentees ou dont une valeur est
// proposee portent une marque ; un clic ouvre leur fil (carte standard de la
// revision), ou l'on repond, accepte, refuse, resout, sans quitter la base.
//
// Un commentaire de cellule vise { cell: { row, key } } (row : id de la
// ligne, note ou ligne legere). Une proposition de valeur (« base.cell »)
// vise sa ligne et sa colonne par son contenu.
import type { PropertyValue, ReviewAnnotation } from '@savoire/plugin-api'
import { CELL_PROPOSAL, type CellProposal } from './proposals'

/** Cible d'un commentaire de cellule. `quote` : « Ligne · Colonne », pour le panneau. */
export interface CellCommentTarget {
  cell: { row: string; key: string }
  quote: string
}

/** Ce qui vise une cellule : ses fils ouverts. */
export interface CellAnnotation {
  ids: string[]
  comments: number
  /** Valeurs proposees, de la plus ancienne a la plus recente. */
  proposals: (PropertyValue | null)[]
}

const cellKey = (row: string, key: string) => `${row}\u0000${key}`

const isCellTarget = (v: unknown): v is CellCommentTarget => {
  const c = (v as CellCommentTarget | null)?.cell
  return !!c && typeof c.row === 'string' && typeof c.key === 'string'
}

/** Les fils ouverts de la base, par cellule. */
export class CellAnnotations {
  private byCell = new Map<string, CellAnnotation>()

  update(annotations: readonly ReviewAnnotation[]): void {
    const next = new Map<string, CellAnnotation>()
    const at = (row: string, key: string) => {
      const k = cellKey(row, key)
      let a = next.get(k)
      if (!a) { a = { ids: [], comments: 0, proposals: [] }; next.set(k, a) }
      return a
    }
    for (const a of annotations) {
      if (a.status !== 'open') continue
      if (a.kind === 'comment' && isCellTarget(a.target)) {
        const cell = at(a.target.cell.row, a.target.cell.key)
        cell.ids.push(a.id)
        cell.comments++
      } else if (a.kind === 'proposal' && a.proposalType === CELL_PROPOSAL) {
        const p = a.payload as CellProposal | null
        const row = p?.row?.kind === 'page' ? p.row.docId : p?.row?.kind === 'light' ? p.row.rowId : null
        if (!p || !row || typeof p.key !== 'string') continue
        const cell = at(row, p.key)
        cell.ids.push(a.id)
        cell.proposals.push(p.after ?? null)
      }
    }
    this.byCell = next
  }

  clear(): void { this.byCell = new Map() }

  of(row: string, key: string): CellAnnotation | null {
    return this.byCell.get(cellKey(row, key)) ?? null
  }

  /** Signature d'une ligne (ce qui la vise) : la redessiner quand elle change. */
  rowSig(row: string): string {
    const prefix = `${row}\u0000`
    const parts: string[] = []
    for (const [k, a] of this.byCell) if (k.startsWith(prefix)) parts.push(`${k}:${a.ids.join(',')}`)
    return parts.sort().join('|')
  }
}
