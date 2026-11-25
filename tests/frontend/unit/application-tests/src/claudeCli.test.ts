// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Claude avec l'abonnement de la personne (protocole « claude-cli ») : lecture
// du flux JSON de Claude Code, message envoye, erreurs en clair, et la
// demande entiere par AIService avec un faux pont (pas de vrai programme).
import { afterEach, describe, it, expect, vi } from 'vitest'
import {
  AIService, AIRequestError, ClaudeCliRunner, ClaudeStreamReader, CLAUDE_CLI_PROTOCOL, claudeErrorMessage, claudePrompt,
  type AIConnection, type AIConnectionStore, type ClaudeCliEvent, type ClaudeCliStart, type ClaudeCliTransport,
} from '@savoire/application'
import type { AIChatRequest, AIMessage, AIProviderSpec, AIToolDefinition } from '@savoire/plugin-api'

function memoryStore(): AIConnectionStore & { list: AIConnection[] } {
  const s = { list: [] as AIConnection[], load: () => s.list.map(c => ({ ...c })), save: (l: AIConnection[]) => { s.list = l.map(c => ({ ...c })) } }
  return s
}

const PROVIDER: AIProviderSpec = {
  id: 'claude-code', name: 'Claude (abonnement, sur cet ordinateur)', protocol: CLAUDE_CLI_PROTOCOL,
  baseUrl: '', requiresKey: false, models: ['sonnet', 'opus', 'haiku'],
}

/** Un faux pont : ce que la page envoie, et de quoi jouer la sortie du programme. */
function fakeTransport() {
  const listeners = new Map<string, (e: ClaudeCliEvent) => void>()
  const t = {
    started: [] as ClaudeCliStart[],
    cancelled: [] as string[],
    replies: [] as { id: number; body: string }[],
    failStart: null as string | null,
    async start(req: ClaudeCliStart, onEvent: (e: ClaudeCliEvent) => void) {
      if (t.failStart) throw new Error(t.failStart)
      t.started.push(req)
      listeners.set(req.run, onEvent)
    },
    async cancel(run: string) {
      t.cancelled.push(run)
      listeners.get(run)?.({ kind: 'exit', code: null, reason: 'cancel', stderr: '' })
    },
    async replyMcp(id: number, body: string) { t.replies.push({ id, body }) },
    async status() { return { found: true, path: '/usr/local/bin/claude', version: '2.1.0 (Claude Code)', chosen: false } },
    async choose(forget?: boolean) { return { found: true, path: forget ? '/usr/local/bin/claude' : '/opt/claude', chosen: !forget } },
    /** La derniere demande lancee. */
    get run(): string { return t.started[t.started.length - 1]!.run },
    line(obj: unknown, run = t.run) { listeners.get(run)!({ kind: 'line', line: JSON.stringify(obj) }) },
    mcp(id: number, msg: unknown, run = t.run) { listeners.get(run)!({ kind: 'mcp', id, body: JSON.stringify(msg) }) },
    exit(code: number | null, stderr = '', reason = 'exit', run = t.run) { listeners.get(run)!({ kind: 'exit', code, reason, stderr }) },
    reply(id: number): any { const r = t.replies.find(x => x.id === id); return r?.body ? JSON.parse(r.body) : r?.body },
  }
  return t satisfies ClaudeCliTransport & Record<string, unknown>
}

const tick = () => new Promise(r => setTimeout(r, 0))

/** Une reponse simple, telle que Claude Code l'ecrit (flux avec morceaux). */
function answer(t: ReturnType<typeof fakeTransport>, text: string[], id = 'msg_1', run?: string) {
  t.line({ type: 'system', subtype: 'init', model: 'claude-sonnet-5', tools: [] }, run)
  t.line({ type: 'stream_event', event: { type: 'message_start', message: { id, model: 'claude-sonnet-5', usage: { input_tokens: 3, cache_read_input_tokens: 7, output_tokens: 1 } } } }, run)
  for (const piece of text) t.line({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: piece } } }, run)
  t.line({ type: 'assistant', message: { id, model: 'claude-sonnet-5', content: [{ type: 'text', text: text.join('') }], usage: { input_tokens: 3, cache_read_input_tokens: 7, output_tokens: 4 } } }, run)
  t.line({ type: 'stream_event', event: { type: 'message_delta', usage: { input_tokens: 3, cache_read_input_tokens: 7, output_tokens: 5 } } }, run)
}

function result(t: ReturnType<typeof fakeTransport>, text: string, run?: string) {
  t.line({ type: 'result', subtype: 'success', is_error: false, result: text }, run)
  t.exit(0, '', 'exit', run)
}

function setup(opts: ConstructorParameters<typeof ClaudeCliRunner>[1] = {}) {
  const t = fakeTransport()
  let n = 0
  const runner = new ClaudeCliRunner(t, { newId: () => `id-${++n}`, ...opts })
  const ai = new AIService(memoryStore(), async () => { throw new Error('aucun appel reseau') })
  ai.registerRunner(runner)
  ai.registerProvider(PROVIDER)
  const conn = ai.saveConnection({ name: 'Claude', providerId: 'claude-code', baseUrl: 'https://ignoree', apiKey: 'jamais', model: 'sonnet' })
  return { t, runner, ai, conn }
}

const SEARCH: AIToolDefinition = { name: 'search', description: 'Cherche des notes.', parameters: { type: 'object', properties: { query: { type: 'string' } } } }

afterEach(() => { vi.useRealTimers() })

describe('flux JSON de Claude Code', () => {
  it('texte en morceaux, sans doublon du message entier, et tokens', () => {
    const r = new ClaudeStreamReader()
    const ev = [
      { type: 'system', subtype: 'init', model: 'claude-haiku-5' },
      { type: 'stream_event', event: { type: 'message_start', message: { id: 'm1', model: 'claude-haiku-5' } } },
      { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'O' } } },
      { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'hmm' } } },
      { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'K' } } },
      { type: 'assistant', message: { id: 'm1', content: [{ type: 'text', text: 'OK' }], usage: { input_tokens: 2, cache_creation_input_tokens: 986, output_tokens: 4 } } },
      { type: 'result', subtype: 'success', is_error: false, result: 'OK' },
    ].flatMap(l => r.push(JSON.stringify(l)))
    expect(ev).toEqual([
      { type: 'model', model: 'claude-haiku-5' },
      { type: 'model', model: 'claude-haiku-5' },
      { type: 'text', text: 'O' },
      { type: 'text', text: 'K' },
      { type: 'usage', messageId: 'm1', inputTokens: 988, outputTokens: 4 },
      { type: 'result', ok: true, text: 'OK' },
    ])
  })

  it('sans morceaux : le message entier ; erreurs, limites, sous-agents et lignes illisibles', () => {
    const r = new ClaudeStreamReader()
    const push = (l: unknown) => r.push(typeof l === 'string' ? l : JSON.stringify(l))
    expect(push({ type: 'assistant', message: { id: 'a', content: [{ type: 'text', text: 'Salut' }, { type: 'tool_use', name: 'x' }] } })).toEqual([{ type: 'text', text: 'Salut' }])
    expect(push({ type: 'assistant', message: { id: 'a', content: [{ type: 'text', text: 'Salut' }] } })).toEqual([])
    expect(push({ type: 'assistant', parent_tool_use_id: 'toolu_1', message: { id: 'b', content: [{ type: 'text', text: 'sous-agent' }] } })).toEqual([])
    expect(push({ type: 'assistant', message: { id: 'c', model: '<synthetic>', content: [{ type: 'text', text: 'Not logged in · Please run /login' }] } })).toEqual([])
    expect(push({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', resetsAt: 1 } })).toEqual([])
    expect(push({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: 1795614000 } })).toEqual([{ type: 'limit', resetsAt: 1795614000 }])
    expect(push({ type: 'result', subtype: 'success', is_error: true, result: 'Not logged in · Please run /login', api_error_status: null })).toEqual([{ type: 'result', ok: false, text: 'Not logged in · Please run /login' }])
    expect(push({ type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['boom'], api_error_status: 529 })).toEqual([{ type: 'result', ok: false, text: 'boom', status: 529 }])
    expect(push('pas du json')).toEqual([])
    expect(push({ type: 'user', message: { content: [{ type: 'tool_result' }] } })).toEqual([])
  })
})

describe('message envoye a Claude', () => {
  it('une demande simple : le message tel quel, les consignes a part', () => {
    expect(claudePrompt({ messages: [{ role: 'system', content: 'Sois bref.' }, { role: 'user', content: 'Résume [[Note]]' }] }))
      .toEqual({ system: 'Sois bref.', prompt: 'Résume [[Note]]' })
    expect(claudePrompt({ messages: [{ role: 'user', content: 'x' }], json: true }).system).toMatch(/objet JSON valide/)
    expect(() => claudePrompt({ messages: [{ role: 'system', content: 'seul' }] })).toThrow(AIRequestError)
  })

  it('une conversation devient un seul message qui la raconte', () => {
    const messages: AIMessage[] = [
      { role: 'system', content: 'Agent.' },
      { role: 'user', content: 'Cherche les crêpes' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'search', arguments: '{"query":"crêpes"}' }] },
      { role: 'tool', toolCallId: 'c1', content: '[[Recettes/Crêpes]]' },
      { role: 'assistant', content: 'Trouvé.' },
      { role: 'user', content: 'Et les gaufres ?' },
    ]
    const { system, prompt } = claudePrompt({ messages })
    expect(system).toBe('Agent.')
    expect(prompt).toContain('<message de="personne">\nCherche les crêpes\n</message>')
    expect(prompt).toContain('[outil demandé : search {"query":"crêpes"}]')
    expect(prompt).toContain('<resultat outil="search">\n[[Recettes/Crêpes]]\n</resultat>')
    expect(prompt.trim().endsWith('Réponds au dernier message de la personne.')).toBe(true)
  })
})

describe('erreurs en clair', () => {
  it('non connecte, limite, surcharge, version, delai', () => {
    expect(claudeErrorMessage({ text: 'Not logged in · Please run /login' })).toMatch(/lancez « claude » une fois/)
    expect(claudeErrorMessage({ status: 401 })).toMatch(/n’est pas connecté/)
    const at = new Date(2026, 10, 25, 15, 7).getTime() / 1000
    expect(claudeErrorMessage({ limited: true, resetsAt: at, text: 'x' })).toBe('Limite d’utilisation de votre abonnement Claude atteinte. Réessayez après 15:07.')
    expect(claudeErrorMessage({ text: 'Claude AI usage limit reached' })).toMatch(/Réessayez plus tard/)
    expect(claudeErrorMessage({ status: 529, text: 'Overloaded' })).toMatch(/surchargés/)
    expect(claudeErrorMessage({ stderr: "error: unknown option '--tools'", code: 1 })).toMatch(/trop ancienne/)
    expect(claudeErrorMessage({ reason: 'timeout' })).toMatch(/trop de temps/)
    expect(claudeErrorMessage({ text: 'Autre chose' })).toBe('Claude Code : Autre chose')
    expect(claudeErrorMessage({ stderr: 'ligne 1\nfin\n', code: 2 })).toBe('Claude Code s’est arrêté (code 2) : fin')
    expect(claudeErrorMessage({ code: null })).toBe('Claude Code s’est arrêté sans répondre.')
  })
})

describe('Claude par AIService', () => {
  it('connexion sans adresse ni cle, modeles, programme, pas de dictee', async () => {
    const { ai, conn, runner } = setup()
    expect(conn).toMatchObject({ baseUrl: '', apiKey: '', model: 'sonnet' })
    expect(ai.runnerFor('claude-code')).toBe(runner)
    expect(ai.runnerFor('openai')).toBeUndefined()
    expect(await ai.listModels({ ...conn })).toEqual(['sonnet', 'opus', 'haiku'])
    expect((await runner.program.status()).version).toMatch(/Claude Code/)
    expect((await runner.program.forget()).chosen).toBe(false)
    await expect(ai.transcribe(new Blob(['x']), { model: 'whisper-1' })).rejects.toThrow(/ne fait pas la dictée/)
    expect(JSON.stringify(ai.pluginAPI().connections())).not.toContain('jamais')
  })

  it('sans le pont (navigateur), le protocole est inconnu ; sans le plugin, un message clair', async () => {
    const ai = new AIService(memoryStore())
    expect(() => ai.registerProvider(PROVIDER)).toThrow(/protocole inconnu/)
    const store = memoryStore()
    store.list = [{ id: 'x', name: 'Claude', providerId: 'claude-code', baseUrl: '', apiKey: '', model: 'sonnet', isDefault: true }]
    await expect(new AIService(store).chat({ messages: [{ role: 'user', content: 'a' }] })).rejects.toThrow(/fournisseur n’est plus installé/)
  })

  it('une reponse en flux : texte au fil de l eau, modele, tokens', async () => {
    const { t, ai } = setup()
    const deltas: string[] = []
    const p = ai.chat({ messages: [{ role: 'system', content: 'Sois bref.' }, { role: 'user', content: 'Dis bonjour' }], onDelta: d => { if (d.text) deltas.push(d.text) } })
    await tick()
    expect(t.started).toEqual([{ run: 'id-1', model: 'sonnet', system: 'Sois bref.', prompt: 'Dis bonjour', tools: false }])
    answer(t, ['Bon', 'jour'])
    result(t, 'Bonjour')
    const r = await p
    expect(deltas).toEqual(['Bon', 'jour'])
    expect(r).toEqual({ text: 'Bonjour', model: 'claude-sonnet-5', connection: 'Claude', usage: { inputTokens: 10, outputTokens: 5 } })
  })

  it('les outils : Claude appelle, le moteur execute, Claude continue', async () => {
    const { t, ai, runner } = setup()
    const messages: AIMessage[] = [{ role: 'system', content: 'Agent.' }, { role: 'user', content: 'Cherche les crêpes' }]
    const first = ai.chat({ messages, tools: [SEARCH] })
    await tick()
    expect(t.started[0]!.tools).toBe(true)
    // Claude Code se branche sur le MCP de la demande.
    t.mcp(1, { jsonrpc: '2.0', id: 'probe', method: 'server/discover' })
    expect(t.reply(1).error.code).toBe(-32601)
    t.mcp(2, { jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-11-25' } })
    expect(t.reply(2).result).toMatchObject({ protocolVersion: '2025-06-18', capabilities: { tools: {} } })
    t.mcp(3, { jsonrpc: '2.0', method: 'notifications/initialized' })
    expect(t.reply(3)).toBe('')
    t.mcp(4, { jsonrpc: '2.0', id: 1, method: 'tools/list' })
    expect(t.reply(4).result.tools).toEqual([{ name: 'search', description: 'Cherche des notes.', inputSchema: SEARCH.parameters }])
    // Un outil qui n'est pas celui de l'agent : refuse sans passer par le moteur.
    t.mcp(5, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'Bash', arguments: { command: 'ls' } } })
    expect(t.reply(5).result.isError).toBe(true)
    answer(t, ['Je cherche.'])
    t.mcp(6, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'search', arguments: { query: 'crêpes' }, _meta: { 'claudecode/toolUseId': 'toolu_1' } } })
    const r1 = await first
    expect(r1.text).toBe('Je cherche.')
    expect(r1.toolCalls).toEqual([{ id: 'toolu_1', name: 'search', arguments: '{"query":"crêpes"}' }])
    // Claude attend : pas encore de reponse a son appel.
    expect(t.reply(6)).toBeUndefined()

    // Le moteur rend le resultat : il repart a Claude, dans la meme demande.
    const deltas: string[] = []
    const second = ai.chat({
      messages: [...messages, { role: 'assistant', content: r1.text, toolCalls: r1.toolCalls }, { role: 'tool', toolCallId: 'toolu_1', content: '[[Recettes/Crêpes]]' }],
      tools: [SEARCH], onDelta: d => { if (d.text) deltas.push(d.text) },
    })
    await tick()
    expect(t.started).toHaveLength(1)
    expect(t.reply(6)).toEqual({ jsonrpc: '2.0', id: 3, result: { content: [{ type: 'text', text: '[[Recettes/Crêpes]]' }], isError: false } })
    answer(t, ['Voir ', '[[Recettes/Crêpes]].'], 'msg_2')
    result(t, 'Voir [[Recettes/Crêpes]].')
    const r2 = await second
    expect(r2.text).toBe('Voir [[Recettes/Crêpes]].')
    expect(r2.toolCalls).toBeUndefined()
    expect(deltas).toEqual(['Voir ', '[[Recettes/Crêpes]].'])
    expect(runner.active).toBe(0)
  })

  it('demande finie : la suite repart dans une nouvelle demande qui raconte la conversation', async () => {
    const { t, ai } = setup()
    const p = ai.chat({ messages: [{ role: 'user', content: 'a' }] })
    await tick()
    answer(t, ['b'])
    result(t, 'b')
    await p
    const q = ai.chat({ messages: [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }, { role: 'user', content: 'c' }] })
    await tick()
    expect(t.started).toHaveLength(2)
    expect(t.started[1]!.prompt).toContain('<message de="assistant">\nb\n</message>')
    result(t, 'd')
    expect((await q).text).toBe('d')
  })

  it('non connecte, programme absent, programme qui s arrete : erreurs lisibles', async () => {
    const { t, ai } = setup()
    const p = ai.chat({ messages: [{ role: 'user', content: 'a' }] })
    await tick()
    t.line({ type: 'assistant', message: { id: 's', model: '<synthetic>', content: [{ type: 'text', text: 'Not logged in · Please run /login' }] } })
    t.line({ type: 'result', subtype: 'success', is_error: true, result: 'Not logged in · Please run /login' })
    await expect(p).rejects.toThrow(/lancez « claude » une fois/)
    t.exit(1)

    const q = ai.chat({ messages: [{ role: 'user', content: 'a' }] })
    await tick()
    t.line({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected' } })
    t.exit(1)
    await expect(q).rejects.toThrow(/Limite d’utilisation/)

    t.failStart = 'Claude Code est introuvable sur cet ordinateur.'
    await expect(ai.chat({ messages: [{ role: 'user', content: 'a' }] })).rejects.toThrow(/introuvable/)
  })

  it('arreter : le programme est tue et la demande finit en AbortError', async () => {
    const { t, ai, runner } = setup()
    const ctl = new AbortController()
    const p = ai.chat({ messages: [{ role: 'user', content: 'long' }], signal: ctl.signal })
    await tick()
    ctl.abort()
    await expect(p).rejects.toMatchObject({ name: 'AbortError' })
    expect(t.cancelled).toEqual(['id-1'])
    expect(runner.active).toBe(0)
    // Deja arretee : rien n'est lance.
    await expect(ai.chat({ messages: [{ role: 'user', content: 'x' }], signal: ctl.signal })).rejects.toMatchObject({ name: 'AbortError' })
    expect(t.started).toHaveLength(1)
  })

  it('delais : Claude muet, ou un outil sans resultat', async () => {
    vi.useFakeTimers()
    const { t, ai } = setup({ silenceMs: 1000, toolWaitMs: 5000 })
    const p = ai.chat({ messages: [{ role: 'user', content: 'a' }] })
    const caught = p.catch(e => e as Error)
    await vi.advanceTimersByTimeAsync(10)
    t.line({ type: 'system', subtype: 'init', model: 'm' })
    await vi.advanceTimersByTimeAsync(900)
    expect(t.cancelled).toEqual([])
    await vi.advanceTimersByTimeAsync(200)
    expect(t.cancelled).toEqual(['id-1'])
    expect((await caught).message).toMatch(/ne répond plus/)

    const q = ai.chat({ messages: [{ role: 'user', content: 'b' }], tools: [SEARCH] })
    await vi.advanceTimersByTimeAsync(10)
    t.mcp(9, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'search', arguments: {} } })
    expect((await q).toolCalls?.[0]).toMatchObject({ id: 'claude-id-3', name: 'search' })
    // Le moteur ne revient pas : la demande est arretee, et Claude n'attend plus.
    await vi.advanceTimersByTimeAsync(5001)
    expect(t.cancelled).toEqual(['id-1', 'id-2'])
    expect(t.reply(9).result.isError).toBe(true)
  })

  it('une demande d un plugin passe par le meme chemin', async () => {
    const { t, ai } = setup()
    const req: AIChatRequest = { messages: [{ role: 'user', content: 'Réponds seulement : OK' }], maxTokens: 10 }
    const p = ai.pluginAPI().chat(req)
    await tick()
    result(t, 'OK')
    expect(await p).toMatchObject({ text: 'OK', connection: 'Claude' })
  })
})
