// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// MCP local (ADR-033) : ce que la page repond a un client MCP du poste.
// Memes outils et memes droits que l'assistant (ToolBox) ; ici on verifie le
// JSON-RPC et que les droits, les accords et les refus passent tels quels.
import { describe, it, expect } from 'vitest'
import { ToolBox, type ApprovalAnswer } from '@savoire/agent-core'
import type { AgentDefinition, ToolActor } from '@savoire/plugin-api'
import { handleLocalMcp } from '../../../../../apps/web/src/agents/localMcp'
import { MemoryHost } from './memoryHost'

const actor: ToolActor = { agentId: 'a1', agentName: 'Archiviste', onBehalfOf: { userId: 'u1', displayName: 'Jean' } }

function agent(p: Partial<AgentDefinition> = {}): AgentDefinition {
  return { id: 'a1', name: 'Archiviste', description: '', instructions: '', ownerId: 'u1', permissions: { read: 'direct' }, ...p }
}

function server(host: MemoryHost, a: AgentDefinition, approve?: (r: unknown) => Promise<ApprovalAnswer>) {
  const box = new ToolBox({ agent: a, person: { canWrite: true }, actor, runtime: 'app', host, ...(approve ? { approve: approve as never } : {}) })
  return (msg: unknown) => handleLocalMcp(typeof msg === 'string' ? msg : JSON.stringify(msg), { toolBox: async () => box })
}

const rpc = (id: number, method: string, params?: unknown) => ({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) })
const parse = async (p: Promise<string>) => JSON.parse(await p)

describe('MCP local : protocole', () => {
  it('initialize : negocie la version, annonce les outils', async () => {
    const call = server(new MemoryHost(), agent())
    const r = await parse(call(rpc(1, 'initialize', { protocolVersion: '2025-03-26' })))
    expect(r.result.protocolVersion).toBe('2025-03-26')
    expect(r.result.capabilities.tools).toBeDefined()
    expect((await parse(call(rpc(2, 'initialize', { protocolVersion: '1999-01-01' })))).result.protocolVersion).toBe('2025-06-18')
  })

  it('une notification ne recoit aucune reponse', async () => {
    expect(await server(new MemoryHost(), agent())({ jsonrpc: '2.0', method: 'notifications/initialized' })).toBe('')
  })

  it('JSON illisible, lot et methode inconnue : erreurs JSON-RPC', async () => {
    const call = server(new MemoryHost(), agent())
    expect((await parse(call('pas du json'))).error.code).toBe(-32700)
    expect((await parse(call([rpc(1, 'ping')]))).error.code).toBe(-32600)
    expect((await parse(call(rpc(3, 'foo/bar')))).error.code).toBe(-32601)
    expect((await parse(call(rpc(4, 'ping')))).result).toEqual({})
  })
})

describe('MCP local : les droits de l agent choisi', () => {
  it('tools/list : lecture seule, aucun outil d ecriture', async () => {
    const r = await parse(server(new MemoryHost(), agent())(rpc(1, 'tools/list')))
    const names = r.result.tools.map((t: { name: string }) => t.name)
    expect(names).toContain('search')
    expect(names).not.toContain('edit_note')
    expect(r.result.tools.every((t: { annotations: { readOnlyHint: boolean } }) => t.annotations.readOnlyHint)).toBe(true)
  })

  it('tools/call : lit une note', async () => {
    const host = new MemoryHost({ 'Projets/Plan.md': 'Le plan.' })
    const r = await parse(server(host, agent())(rpc(1, 'tools/call', { name: 'read_note', arguments: { path: 'Projets/Plan.md' } })))
    expect(r.result.isError).toBe(false)
    expect(r.result.content[0].text).toContain('Le plan.')
  })

  it('un outil non permis est refuse comme inconnu, et rien n est ecrit', async () => {
    const host = new MemoryHost({ 'a.md': 'x' })
    const r = await parse(server(host, agent())(rpc(1, 'tools/call', { name: 'create_note', arguments: { path: 'b.md', content: 'y' } })))
    expect(r.error.code).toBe(-32602)
    expect(host.writes).toEqual([])
  })

  it('mode « demander » : refus de la personne = rien d ecrit ; accord = fait', async () => {
    const a = agent({ permissions: { read: 'direct', create: 'ask' } })
    const asked: string[] = []
    const refused = new MemoryHost()
    const r1 = await parse(server(refused, a, async (req) => { asked.push((req as { summary: string }).summary); return 'refused' })(rpc(1, 'tools/call', { name: 'create_note', arguments: { path: 'b.md', content: 'y' } })))
    expect(r1.result.isError).toBe(true)
    expect(asked[0]).toContain('b.md')
    expect(refused.notes.size).toBe(0)

    const accepted = new MemoryHost()
    const r2 = await parse(server(accepted, a, async () => 'approved')(rpc(2, 'tools/call', { name: 'create_note', arguments: { path: 'b.md', content: 'y' } })))
    expect(r2.result.isError).toBe(false)
    expect(accepted.notes.size).toBe(1)
  })

  it('pas de boite d outils (MCP coupe, aucun agent) : erreur lisible', async () => {
    const r = await parse(handleLocalMcp(JSON.stringify(rpc(1, 'tools/list')), { toolBox: async () => { throw new Error('Aucun agent choisi.') } }))
    expect(r.error.message).toBe('Aucun agent choisi.')
    const c = await parse(handleLocalMcp(JSON.stringify(rpc(2, 'tools/call', { name: 'search' })), { toolBox: async () => { throw new Error('Aucun agent choisi.') } }))
    expect(c.error.message).toBe('Aucun agent choisi.')
  })
})
