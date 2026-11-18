// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Outils des agents apportes par les bases (ADR-033). Ils tournent dans
// l'appli, avec la PluginAPI du plugin ; l'application a deja verifie les
// droits de l'agent (action « plugin ») et dit s'il faut faire ou proposer.
//
//  - base_describe : colonnes d'une base et quelques lignes ;
//  - base_set_cell : changer une cellule (proposition = la meme que celle
//    du mode suggestion, appliquee par le meme code a l'acceptation).
import type { PluginAPI, PluginTool, PropertyValue, QueryRow } from '@savoire/plugin-api'
import { CELL_PROPOSAL, cellProposalType, type CellProposal } from './proposals'

function baseRef(api: PluginAPI, ref: unknown): { id: string; path: string } {
  if (typeof ref !== 'string' || !ref.trim()) throw new Error('Donnez la base (chemin ou id).')
  const tree = api.vault.getFileTree?.() ?? []
  const wanted = ref.trim()
  const hit = tree.find(f => f.docId === wanted || f.path === wanted || f.path.toLowerCase() === `${wanted.toLowerCase()}.base` || f.path.toLowerCase() === wanted.toLowerCase())
  if (!hit || !hit.path.endsWith('.base')) throw new Error(`Base introuvable : ${wanted}.`)
  return { id: hit.docId, path: hit.path }
}

async function rowsOf(api: PluginAPI, baseId: string, limit: number): Promise<{ rows: QueryRow[]; total: number }> {
  if (!api.query) throw new Error('Requêtes indisponibles.')
  const r = await api.query.query({ from: { base: baseId }, limit })
  return { rows: r.rows, total: r.total }
}

export function baseAgentTools(api: PluginAPI): PluginTool[] {
  const describe: PluginTool = {
    spec: {
      name: 'base_describe', title: 'Décrire une base', action: 'read',
      description: 'Les colonnes d’une base (.base) et ses premières lignes (id, titre, valeurs). À lire avant de changer une cellule.',
      inputSchema: { type: 'object', properties: { base: { type: 'string', description: 'Chemin ou id de la base.' }, limit: { type: 'integer', description: 'Lignes (1 à 50, 10 par défaut).' } }, required: ['base'], additionalProperties: false },
    },
    async run(args) {
      const base = baseRef(api, args.base)
      const limit = Math.max(1, Math.min(50, typeof args.limit === 'number' ? Math.floor(args.limit) : 10))
      const { rows, total } = await rowsOf(api, base.id, limit)
      const keys = [...new Set(rows.flatMap(r => Object.keys(r.values ?? {})))]
      const lines = rows.map(r => `- ${r.title || r.id} (ligne ${r.id}) — ${keys.map(k => `${k}: ${JSON.stringify(r.values?.[k] ?? null)}`).join(', ')}`)
      return { text: `${base.path} : ${total} ligne(s), colonnes ${keys.join(', ') || '(aucune)'}.\n${lines.join('\n')}`, data: { keys, rows }, sources: [{ docId: base.id, path: base.path }] }
    },
  }

  const setCell: PluginTool = {
    spec: {
      name: 'base_set_cell', title: 'Changer une cellule de base', action: 'plugin',
      description: 'Change la valeur d’une cellule d’une base : la ligne (id rendu par base_describe), la colonne, la nouvelle valeur (vide : effacer).',
      inputSchema: {
        type: 'object',
        properties: {
          base: { type: 'string', description: 'Chemin ou id de la base.' },
          row: { type: 'string', description: 'Id de la ligne.' },
          column: { type: 'string', description: 'Nom de la colonne (propriété).' },
          value: { type: 'string', description: 'Nouvelle valeur (texte, nombre, date ISO). Vide : effacer.' },
        },
        required: ['base', 'row', 'column'],
        additionalProperties: false,
      },
    },
    async run(args, ctx) {
      const base = baseRef(api, args.base)
      const key = typeof args.column === 'string' ? args.column.trim() : ''
      if (!key) throw new Error('Donnez la colonne.')
      const { rows } = await rowsOf(api, base.id, 500)
      const row = rows.find(r => r.id === args.row || r.path === args.row)
      if (!row) throw new Error(`Ligne introuvable : ${String(args.row)}.`)
      const raw = args.value
      const after = (raw === undefined || raw === null || raw === '' ? null : typeof raw === 'number' || typeof raw === 'boolean' ? raw : String(raw)) as PropertyValue | null
      const before = (row.values?.[key] ?? null) as PropertyValue | null
      if (JSON.stringify(before) === JSON.stringify(after)) return { text: 'Rien à changer.' }
      const proposal: CellProposal = {
        row: row.path === '' ? { kind: 'light', baseId: base.id, rowId: row.id } : { kind: 'page', docId: row.id },
        title: row.title || row.id, key, before, after,
      }
      if (ctx.mode === 'propose') {
        if (!api.review) throw new Error('Révision indisponible.')
        const id = await api.review.propose(base.id, CELL_PROPOSAL, proposal, `${ctx.actor.agentName} propose ${key} = ${JSON.stringify(after)}`)
        return { text: `Proposition déposée dans la Révision de ${base.path} : ${row.title || row.id} · ${key}.`, data: { proposalId: id }, sources: [{ docId: base.id, path: base.path }] }
      }
      // Fait : le meme code que l'acceptation d'une proposition (verifie que la cellule n'a pas change).
      await cellProposalType(api).apply(base.id, proposal)
      return { text: `${base.path} : ${row.title || row.id} · ${key} = ${JSON.stringify(after)}.`, sources: [{ docId: base.id, path: base.path }] }
    },
  }

  return [describe, setCell]
}
