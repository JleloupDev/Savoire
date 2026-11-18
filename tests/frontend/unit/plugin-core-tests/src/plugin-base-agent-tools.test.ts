// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Outils d'agent des bases (ADR-033) : decrire une base, changer une cellule
// en proposition (la meme que le mode suggestion) ou directement.
import { describe, it, expect, vi } from 'vitest'
import { CELL_PROPOSAL, baseAgentTools } from '@savoire/plugin-base'
import type { PluginAPI, ToolContext } from '@savoire/plugin-api'

const actor = { agentId: 'a', agentName: 'Bibliothécaire', onBehalfOf: { userId: 'u', displayName: 'Jean' } }

function fakeApi() {
  const propose = vi.fn(async () => 'p1')
  const api = {
    vault: { getFileTree: () => [{ docId: 'b1', path: 'Lectures.base' }, { docId: 'n1', path: 'Livres/Dune.md' }] },
    query: { query: vi.fn(async () => ({ rows: [{ id: 'r1', path: '', title: 'Dune', values: { auteur: 'Herbert', lu: false } }], total: 1 })) },
    review: { propose },
  } as unknown as PluginAPI
  return { api, propose }
}

describe('outils d agent des bases', () => {
  it('decrit la base : colonnes et lignes', async () => {
    const { api } = fakeApi()
    const [describeTool] = baseAgentTools(api)
    const r = await describeTool!.run({ base: 'Lectures' }, { mode: 'direct', actor } as ToolContext)
    expect(r.text).toContain('colonnes auteur, lu')
    expect(r.text).toContain('Dune (ligne r1)')
  })

  it('en proposition : la proposition de cellule du mode suggestion, rien n est ecrit', async () => {
    const { api, propose } = fakeApi()
    const setCell = baseAgentTools(api)[1]!
    expect(setCell.spec.action).toBe('plugin')
    const r = await setCell.run({ base: 'b1', row: 'r1', column: 'lu', value: 'oui' }, { mode: 'propose', actor } as ToolContext)
    expect(r.isError).toBeFalsy()
    expect(propose).toHaveBeenCalledWith('b1', CELL_PROPOSAL, { row: { kind: 'light', baseId: 'b1', rowId: 'r1' }, title: 'Dune', key: 'lu', before: false, after: 'oui' }, expect.stringContaining('Bibliothécaire'))
  })

  it('une base inconnue ou une ligne absente : une erreur claire', async () => {
    const { api } = fakeApi()
    const setCell = baseAgentTools(api)[1]!
    await expect(setCell.run({ base: 'Nope', row: 'r1', column: 'lu' }, { mode: 'propose', actor } as ToolContext)).rejects.toThrow('Base introuvable')
    await expect(setCell.run({ base: 'b1', row: 'r9', column: 'lu', value: 'x' }, { mode: 'propose', actor } as ToolContext)).rejects.toThrow('Ligne introuvable')
  })
})
