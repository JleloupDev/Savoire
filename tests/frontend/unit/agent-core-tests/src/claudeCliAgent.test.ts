// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Un agent qui parle a Claude par l'abonnement (protocole claude-cli) : Claude
// ne voit que les outils de l'agent, et chaque appel passe par le moteur
// (droits, accords). Le programme claude est joue par un faux pont.
import { describe, it, expect, vi } from 'vitest'
import { AgentEngine, ToolBox, type ApprovalAnswer, type ApprovalRequest } from '@savoire/agent-core'
import { AIService, ClaudeCliRunner, type AIConnection, type ClaudeCliEvent, type ClaudeCliStart } from '../../../../../packages/application/src/index'
import type { AgentDefinition, ToolActor } from '@savoire/plugin-api'
import { MemoryHost } from './memoryHost'

const actor: ToolActor = { agentId: 'a1', agentName: 'Archiviste', onBehalfOf: { userId: 'u1', displayName: 'Jean' } }

function setup(a: AgentDefinition, host: MemoryHost, approve?: (r: ApprovalRequest) => Promise<ApprovalAnswer>) {
  const listeners = new Map<string, (e: ClaudeCliEvent) => void>()
  const started: ClaudeCliStart[] = []
  const replies = new Map<number, string>()
  const transport = {
    start: async (req: ClaudeCliStart, on: (e: ClaudeCliEvent) => void) => { started.push(req); listeners.set(req.run, on) },
    cancel: async () => {},
    replyMcp: async (id: number, body: string) => { replies.set(id, body) },
    status: async () => ({ found: true, chosen: false }),
    choose: async () => ({ found: true, chosen: true }),
  }
  let list: AIConnection[] = []
  const ai = new AIService({ load: () => list, save: l => { list = l } })
  ai.registerRunner(new ClaudeCliRunner(transport))
  ai.registerProvider({ id: 'claude-code', name: 'Claude', protocol: 'claude-cli', baseUrl: '', requiresKey: false })
  const conn = ai.saveConnection({ name: 'Claude', providerId: 'claude-code', baseUrl: '', apiKey: '', model: 'sonnet' })
  const person = { canWrite: true }
  const tools = new ToolBox({ agent: a, person, actor, runtime: 'app', host, ...(approve ? { approve } : {}) })
  const engine = new AgentEngine({ agent: a, person, actor, tools, chat: req => ai.chat(req, conn.id), ...(approve ? { approve } : {}) })
  const emit = (e: ClaudeCliEvent) => listeners.get(started[0]!.run)!(e)
  const claude = {
    started,
    mcp: (id: number, msg: unknown) => emit({ kind: 'mcp', id, body: JSON.stringify(msg) }),
    line: (obj: unknown) => emit({ kind: 'line', line: JSON.stringify(obj) }),
    reply: (id: number) => JSON.parse(replies.get(id)!),
    replied: (id: number) => replies.has(id),
    finish(text: string) {
      claude.line({ type: 'assistant', message: { id: `m-${text.length}`, content: [{ type: 'text', text }], usage: { input_tokens: 10, output_tokens: 3 } } })
      claude.line({ type: 'result', subtype: 'success', is_error: false, result: text })
      emit({ kind: 'exit', code: 0, reason: 'exit', stderr: '' })
    },
    async tools(): Promise<string[]> {
      claude.mcp(100, { jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-06-18' } })
      claude.mcp(101, { jsonrpc: '2.0', id: 1, method: 'tools/list' })
      return (claude.reply(101).result.tools as { name: string }[]).map(t => t.name)
    },
  }
  return { engine, claude }
}

describe('agent avec Claude (abonnement)', () => {
  it('Claude cherche par les outils de l agent, le moteur les execute', async () => {
    const host = new MemoryHost({ 'Recettes/Crêpes.md': 'Ma recette de crêpes : farine, œufs, lait.' })
    const a: AgentDefinition = { id: 'a1', name: 'Archiviste', description: '', instructions: '', ownerId: 'u1', permissions: { read: 'direct' } }
    const { engine, claude } = setup(a, host)
    const running = engine.run('Que dit ma recette de crêpes ?')
    await vi.waitFor(() => expect(claude.started).toHaveLength(1))
    expect(claude.started[0]!.tools).toBe(true)
    // Les consignes de l'agent partent en consignes systeme, la demande par l'entree standard.
    expect(claude.started[0]!.system).toContain('« Archiviste »')
    expect(claude.started[0]!.prompt).toBe('Que dit ma recette de crêpes ?')
    const names = await claude.tools()
    expect(names).toContain('search')
    // Lecture seule : aucun outil d'ecriture n'est propose a Claude.
    expect(names).not.toContain('edit_note')
    expect(names).not.toContain('create_note')

    claude.mcp(102, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'search', arguments: { query: 'crêpes' }, _meta: { 'claudecode/toolUseId': 'toolu_9' } } })
    await vi.waitFor(() => expect(claude.replied(102)).toBe(true))
    expect(claude.reply(102).result.content[0].text).toContain('Recettes/Crêpes.md')
    claude.finish('Farine, œufs et lait : voir [[Recettes/Crêpes]].')
    const run = await running
    expect(run.status).toBe('done')
    expect(run.answer).toBe('Farine, œufs et lait : voir [[Recettes/Crêpes]].')
    expect(run.steps.map(s => `${s.kind}:${s.name ?? ''}`)).toEqual(['model:', 'tool:search', 'model:'])
    expect(run.sources.map(s => s.path)).toEqual(['Recettes/Crêpes.md'])
    expect(run.connection).toBe('Claude')
  })

  it('une action « demander » attend l accord de la personne ; refusee, Claude le sait', async () => {
    const host = new MemoryHost({})
    const a: AgentDefinition = { id: 'a1', name: 'Archiviste', description: '', instructions: '', ownerId: 'u1', permissions: { read: 'direct', create: 'ask' } }
    const asked: ApprovalRequest[] = []
    const { engine, claude } = setup(a, host, async r => { asked.push(r); return 'refused' })
    const running = engine.run('Crée une note Idées')
    await vi.waitFor(() => expect(claude.started).toHaveLength(1))
    expect(await claude.tools()).toContain('create_note')
    claude.mcp(102, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'create_note', arguments: { path: 'Idées.md', content: '# Idées' } } })
    await vi.waitFor(() => expect(claude.replied(102)).toBe(true))
    expect(asked.map(r => r.tool.name)).toEqual(['create_note'])
    expect(claude.reply(102).result.content[0].text).toMatch(/refus/i)
    expect([...host.notes.values()].some(n => n.path === 'Idées.md')).toBe(false)
    claude.finish('La création a été refusée.')
    const run = await running
    expect(run.steps.find(s => s.kind === 'tool')?.status).toBe('refused')
  })
})
