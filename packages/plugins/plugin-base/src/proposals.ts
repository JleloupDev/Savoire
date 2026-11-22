// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Propositions de modification d'une base (Revision, mode suggestion) : en
// mode suggestion, changer une cellule ne l'ecrit pas, cela propose la valeur.
// Accepter la proposition l'ecrit (frontmatter de la ligne-page, ou carte de
// la ligne legere dans son lot), si la cellule n'a pas change entre-temps.
import { BASE_ROW_TITLE, parseFrontmatter } from '@savoire/plugin-api'
import type { PluginAPI, PropertyValue, ProposalTypeSpec } from '@savoire/plugin-api'
import { LightRows } from './rows'
import { ManifestStore, TITLE_COLUMN, readManifest } from './manifest'
import { renamePageRow, writeNoteProperty } from './notes'

export const CELL_PROPOSAL = 'base.cell'

/** Une valeur de cellule proposee. */
export interface CellProposal {
  /** Ligne-page (une note) ou ligne legere (dans un lot de la base). */
  row: { kind: 'page'; docId: string; path?: string } | { kind: 'light'; baseId: string; rowId: string }
  /** Nom affiche de la ligne (son titre), pour le panneau. */
  title: string
  /** Propriete, ou TITLE_COLUMN : renommer la ligne. */
  key: string
  before: PropertyValue | null
  after: PropertyValue | null
}

const show = (v: PropertyValue | null | undefined): string =>
  v === null || v === undefined || v === '' ? '(vide)' : Array.isArray(v) ? v.join(', ') : String(v)

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)

function asCell(payload: unknown): CellProposal {
  const p = payload as CellProposal
  if (!p || typeof p.key !== 'string' || !p.row || (p.row.kind !== 'page' && p.row.kind !== 'light')) throw new Error('Proposition de cellule illisible.')
  return p
}

/** Ce que vaut la cellule aujourd'hui : la valeur ecrite, pour verifier avant d'appliquer. */
async function currentValue(api: PluginAPI, p: CellProposal): Promise<PropertyValue | null> {
  if (p.row.kind === 'page') {
    const fm = parseFrontmatter(await api.vault.read(p.row.docId)) as Record<string, unknown> | null
    return (fm?.[p.key] ?? null) as PropertyValue | null
  }
  const rows = await openRows(api, p.row.baseId)
  try {
    const row = await rows.rows.get(p.row.rowId)
    if (p.key === TITLE_COLUMN) return row?.title ?? null
    return row?.values[p.key] ?? null
  } finally {
    rows.close()
  }
}

/** Les lignes legeres d'une base, ouvertes le temps d'un acces. */
async function openRows(api: PluginAPI, baseId: string): Promise<{ rows: LightRows; close(): void }> {
  const vault = api.vault
  if (!vault.sharedData || !vault.openTree) throw new Error('Lignes légères indisponibles sans synchronisation du vault.')
  const tree = await vault.openTree(baseId)
  const rows = new LightRows(vault.sharedData(baseId), new ManifestStore(tree, () => readManifest(tree, '')), () => readManifest(tree, '').lotCount)
  return { rows, close: () => { rows.close(); vault.closeTree?.(baseId) } }
}

export function cellProposalType(api: PluginAPI): ProposalTypeSpec {
  return {
    type: CELL_PROPOSAL,
    label: 'Cellule de base',
    describe(payload) {
      const p = asCell(payload)
      return `${p.title} · ${p.key === TITLE_COLUMN ? 'Nom' : p.key} : ${show(p.before)} → ${show(p.after)}`
    },
    async apply(_docId, payload) {
      const p = asCell(payload)
      // Renommer une ligne-page : c'est renommer sa note (les liens suivent).
      if (p.key === TITLE_COLUMN && p.row.kind === 'page') {
        const path = p.row.path
        if (!path || api.vault.resolveDocumentId(path) !== p.row.docId) throw new Error('La page a été renommée ou déplacée depuis la proposition.')
        await renamePageRow(api.vault, p.row.docId, path, String(p.after ?? '').trim() || 'Sans titre')
        return
      }
      const now = await currentValue(api, p).catch(() => undefined)
      if (now !== undefined && !same(show(now), show(p.before))) throw new Error(`La cellule « ${p.key} » a changé depuis la proposition (${show(now)}).`)
      if (p.row.kind === 'page') {
        await writeNoteProperty(api.vault, p.row.docId, p.key, (p.after ?? undefined) as PropertyValue | undefined)
        return
      }
      const rows = await openRows(api, p.row.baseId)
      try {
        const key = p.key === TITLE_COLUMN ? BASE_ROW_TITLE : p.key
        await rows.rows.setCell(p.row.rowId, key, (p.after ?? (key === BASE_ROW_TITLE ? '' : null)) as PropertyValue)
      } finally {
        rows.close()
      }
    },
  }
}
