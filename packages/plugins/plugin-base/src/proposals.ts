// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Propositions de modification d'une base (Revision, mode suggestion) : en
// mode suggestion, changer une cellule ne l'ecrit pas, cela propose la valeur.
// Accepter la proposition l'ecrit (frontmatter de la ligne-page, ou carte de
// la ligne legere dans son lot), si la cellule n'a pas change entre-temps.
import { parseFrontmatter } from '@savoire/plugin-api'
import type { PluginAPI, PropertyValue, ProposalTypeSpec } from '@savoire/plugin-api'
import { LightRows } from './rows'
import { ManifestStore, readManifest } from './manifest'
import { writeNoteProperty } from './notes'

export const CELL_PROPOSAL = 'base.cell'

/** Une valeur de cellule proposee. */
export interface CellProposal {
  /** Ligne-page (une note) ou ligne legere (dans un lot de la base). */
  row: { kind: 'page'; docId: string } | { kind: 'light'; baseId: string; rowId: string }
  /** Nom affiche de la ligne (son titre), pour le panneau. */
  title: string
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
    return (await rows.rows.get(p.row.rowId))?.values[p.key] ?? null
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
      return `${p.title} · ${p.key} : ${show(p.before)} → ${show(p.after)}`
    },
    async apply(_docId, payload) {
      const p = asCell(payload)
      const now = await currentValue(api, p).catch(() => undefined)
      if (now !== undefined && !same(show(now), show(p.before))) throw new Error(`La cellule « ${p.key} » a changé depuis la proposition (${show(now)}).`)
      if (p.row.kind === 'page') {
        await writeNoteProperty(api.vault, p.row.docId, p.key, (p.after ?? undefined) as PropertyValue | undefined)
        return
      }
      const rows = await openRows(api, p.row.baseId)
      try {
        await rows.rows.setCell(p.row.rowId, p.key, (p.after ?? null) as PropertyValue)
      } finally {
        rows.close()
      }
    },
  }
}
