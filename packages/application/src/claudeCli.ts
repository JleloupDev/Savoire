// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Claude avec l'abonnement de la personne (plugin-ai-claude-code), bureau
// seulement : le protocole « claude-cli ». L'application lance le
// programme `claude` (Claude Code) que la personne a installe et connecte ;
// elle ne touche jamais a ses identifiants. La coquille bureau
// (apps/desktop/src-tauri/src/claude_cli.rs) lance le programme et rend sa
// sortie ligne a ligne ; ce fichier lit le flux JSON et tient le contrat
// d'AIService : texte au fil de l'eau, appels d'outils, arret.
//
// Outils : Claude ne voit que ceux de la demande (request.tools), par un MCP
// propre a la demande. Quand il en appelle un, la reponse de chat() rend
// l'appel (toolCalls) au moteur d'agents, qui verifie les droits, demande
// l'accord s'il le faut et l'execute ; Claude attend. Le chat() suivant
// porte le resultat (message « tool ») : il repart a Claude, qui continue
// la meme conversation. Rien ne change pour le moteur.
import type { AIChatRequest, AIMessage, AIStreamDelta, AIToolCall, AIToolDefinition } from '@savoire/plugin-api'
import type { AIProtocolResult } from './aiProtocols'
import { AIRequestError, type AIProgram, type AIProgramStatus, type AIRunner, type AIRunnerCall } from './AIService'

export const CLAUDE_CLI_PROTOCOL = 'claude-cli'

/** Alias de Claude Code : toujours le dernier modele de chaque famille. */
export const CLAUDE_CLI_MODELS = ['sonnet', 'opus', 'haiku']

// ── Le pont vers la coquille ────────────────────────────────────────────────

export interface ClaudeCliStart {
  /** Identifiant de la demande (lettres, chiffres, tirets). */
  run: string
  model?: string
  /** Consignes systeme ('' : celles par defaut). */
  system: string
  /** Le message, envoye par l'entree standard du programme. */
  prompt: string
  /** Donner a Claude les outils de la demande (MCP). */
  tools: boolean
}

export type ClaudeCliEvent =
  | { kind: 'line'; line: string }
  | { kind: 'mcp'; id: number; body: string }
  | { kind: 'exit'; code: number | null; reason: string; stderr: string }

export interface ClaudeCliTransport {
  /** Lance une demande ; ses evenements arrivent a onEvent, jusqu'a « exit ». */
  start(req: ClaudeCliStart, onEvent: (e: ClaudeCliEvent) => void): Promise<void>
  cancel(run: string): Promise<void>
  /** Repond a un message MCP de la demande ('' : c'etait une notification). */
  replyMcp(id: number, body: string): Promise<void>
  status(): Promise<AIProgramStatus>
  /** Boite de dialogue du systeme ; forget : revenir a la recherche sur le poste. */
  choose(forget?: boolean): Promise<AIProgramStatus>
}

// ── Le flux JSON de Claude Code ─────────────────────────────────────────────

export type ClaudeStreamEvent =
  | { type: 'text'; text: string }
  | { type: 'usage'; messageId: string; inputTokens: number; outputTokens: number }
  | { type: 'model'; model: string }
  | { type: 'limit'; resetsAt?: number }
  | { type: 'result'; ok: boolean; text: string; status?: number }

type Usage = { input_tokens?: number; output_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number }
type Block = { type?: string; text?: string }
type Line = {
  type?: string
  subtype?: string
  model?: string
  parent_tool_use_id?: string | null
  event?: {
    type?: string
    message?: { id?: string; model?: string; usage?: Usage }
    delta?: { type?: string; text?: string }
    usage?: Usage
  }
  message?: { id?: string; model?: string; content?: Block[] | string; usage?: Usage }
  rate_limit_info?: { status?: string; resetsAt?: number }
  is_error?: boolean
  result?: unknown
  errors?: unknown
  api_error_status?: number | null
}

/** Tokens d'un message : le contexte entier (cache compris) et la reponse. */
function usageEvent(messageId: string, u: Usage | undefined): ClaudeStreamEvent[] {
  if (!u) return []
  const input = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0)
  return [{ type: 'usage', messageId, inputTokens: input, outputTokens: u.output_tokens ?? 0 }]
}

/**
 * Lit la sortie de `claude -p --output-format stream-json --verbose
 * --include-partial-messages`, ligne a ligne. Le texte arrive en morceaux
 * (stream_event) ; un message entier dont rien n'est venu en morceaux est
 * rendu d'un coup. Les messages des sous-agents sont ignores.
 */
export class ClaudeStreamReader {
  private current = ''
  private readonly streamed = new Set<string>()
  private readonly shown = new Map<string, Set<string>>()

  push(raw: string): ClaudeStreamEvent[] {
    let d: Line
    try { d = JSON.parse(raw) as Line } catch { return [] }
    if (!d || typeof d !== 'object' || d.parent_tool_use_id) return []
    switch (d.type) {
      case 'system':
        return d.subtype === 'init' && typeof d.model === 'string' ? [{ type: 'model', model: d.model }] : []
      case 'stream_event': {
        const e = d.event
        if (e?.type === 'message_start') {
          this.current = e.message?.id ?? ''
          return [...(e.message?.model ? [{ type: 'model' as const, model: e.message.model }] : []), ...usageEvent(this.current, e.message?.usage)]
        }
        if (e?.type === 'content_block_delta' && e.delta?.type === 'text_delta' && e.delta.text) {
          this.streamed.add(this.current)
          return [{ type: 'text', text: e.delta.text }]
        }
        if (e?.type === 'message_delta') return usageEvent(this.current, e.usage)
        return []
      }
      case 'assistant': {
        const m = d.message
        const id = m?.id ?? ''
        const out: ClaudeStreamEvent[] = [...usageEvent(id, m?.usage)]
        // Un message « synthetique » porte une erreur (non connecte...) : le resultat la dira.
        if (this.streamed.has(id) || m?.model === '<synthetic>') return out
        const blocks = typeof m?.content === 'string' ? [{ type: 'text', text: m.content }] : m?.content ?? []
        const seen = this.shown.get(id) ?? new Set<string>()
        this.shown.set(id, seen)
        for (const b of blocks) {
          if (b?.type !== 'text' || !b.text || seen.has(b.text)) continue
          seen.add(b.text)
          out.push({ type: 'text', text: b.text })
        }
        return out
      }
      case 'rate_limit_event': {
        const info = d.rate_limit_info
        return info?.status === 'rejected' ? [{ type: 'limit', ...(typeof info.resetsAt === 'number' ? { resetsAt: info.resetsAt } : {}) }] : []
      }
      case 'result': {
        const text = typeof d.result === 'string' ? d.result
          : Array.isArray(d.errors) ? d.errors.filter(x => typeof x === 'string').join(' ') : ''
        return [{
          type: 'result', ok: d.is_error !== true && d.subtype === 'success', text,
          ...(typeof d.api_error_status === 'number' ? { status: d.api_error_status } : {}),
        }]
      }
      default:
        return []
    }
  }
}

// ── Messages d'erreur ───────────────────────────────────────────────────────

export interface ClaudeFailure {
  /** Texte du resultat en erreur. */
  text?: string
  stderr?: string
  /** Statut HTTP de l'API, s'il y en a un. */
  status?: number
  /** Limite de l'abonnement atteinte (rate_limit_event), et sa fin (secondes). */
  limited?: boolean
  resetsAt?: number
  code?: number | null
  reason?: string
}

const pad = (n: number): string => String(n).padStart(2, '0')

/** Ce qu'on dit a la personne, en clair. */
export function claudeErrorMessage(f: ClaudeFailure): string {
  const text = (f.text ?? '').trim()
  const stderr = (f.stderr ?? '').trim()
  const all = `${text}\n${stderr}`
  if (f.reason === 'timeout') return 'Claude a mis trop de temps à répondre : la demande est arrêtée.'
  if (f.limited || f.status === 429 || /usage limit|limit reached|hit your limit|rate.?limit|quota/i.test(all)) {
    const at = f.resetsAt ? new Date(f.resetsAt * 1000) : null
    return `Limite d’utilisation de votre abonnement Claude atteinte. ${at ? `Réessayez après ${pad(at.getHours())}:${pad(at.getMinutes())}.` : 'Réessayez plus tard.'}`
  }
  if (f.status === 401 || /not logged in|\/login|log ?in again|invalid api key|oauth token|authenticat|credential|unauthori[sz]ed/i.test(all)) {
    return 'Claude Code n’est pas connecté sur cet ordinateur. Ouvrez un terminal, lancez « claude » une fois et connectez-vous avec votre abonnement, puis réessayez.'
  }
  if (f.status === 529 || /overloaded/i.test(all)) return 'Les serveurs de Claude sont surchargés : réessayez dans un moment.'
  if (/unknown option|unknown argument|error: option/i.test(stderr)) {
    return 'Cette version de Claude Code est trop ancienne pour Savoire : mettez-la à jour (« claude update » dans un terminal).'
  }
  const code = f.code !== undefined && f.code !== null ? ` (code ${f.code})` : ''
  if (text) return `Claude Code : ${text.slice(0, 300)}`
  const last = stderr.split(/\r?\n/).filter(l => l.trim()).pop()
  if (last) return `Claude Code s’est arrêté${code} : ${last.slice(0, 300)}`
  return `Claude Code s’est arrêté sans répondre${code}.`
}

// ── La demande ──────────────────────────────────────────────────────────────

const JSON_RULE = 'Réponds uniquement par un objet JSON valide, sans texte autour ni bloc de code.'

/**
 * Consignes systeme et message : Claude Code ne prend qu'un message de la
 * personne. Une conversation (historique, appels d'outils) devient un seul
 * message qui la raconte.
 */
export function claudePrompt(request: Pick<AIChatRequest, 'messages' | 'json'>): { system: string; prompt: string } {
  const system = [...request.messages.filter(m => m.role === 'system').map(m => m.content.trim()).filter(Boolean), ...(request.json ? [JSON_RULE] : [])].join('\n\n')
  const rest = request.messages.filter(m => m.role !== 'system')
  if (!rest.length) throw new AIRequestError('Rien à demander à Claude : le message est vide.')
  if (rest.length === 1 && rest[0]!.role === 'user') return { system, prompt: rest[0]!.content }
  const toolNames = new Map<string, string>()
  for (const m of rest) for (const c of m.toolCalls ?? []) toolNames.set(c.id, c.name)
  const part = (m: AIMessage): string => {
    if (m.role === 'user') return `<message de="personne">\n${m.content}\n</message>`
    if (m.role === 'tool') return `<resultat outil="${toolNames.get(m.toolCallId ?? '') ?? 'outil'}">\n${m.content}\n</resultat>`
    const calls = (m.toolCalls ?? []).map(c => `[outil demandé : ${c.name} ${c.arguments}]`)
    return `<message de="assistant">\n${[m.content, ...calls].filter(Boolean).join('\n')}\n</message>`
  }
  const last = rest[rest.length - 1]!
  return {
    system,
    prompt: [
      'Voici la conversation jusqu’ici.',
      ...rest.map(part),
      last.role === 'user' ? 'Réponds au dernier message de la personne.' : 'Continue à partir de là.',
    ].join('\n\n'),
  }
}

// ── Le serveur MCP de la demande ────────────────────────────────────────────

/** Memes versions que le MCP local (apps/web/src/agents/localMcp.ts). */
const MCP_PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05']

type RpcId = string | number | null
const rpcOk = (id: RpcId, result: unknown): string => JSON.stringify({ jsonrpc: '2.0', id, result })
const rpcFail = (id: RpcId, code: number, message: string): string => JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })
const toolText = (id: RpcId, text: string, isError: boolean): string => rpcOk(id, { content: [{ type: 'text', text }], isError })

function abortError(): Error {
  return Object.assign(new Error('Arrêté.'), { name: 'AbortError' })
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function uuid(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

interface PendingCall { mcpId: number; rpcId: RpcId; call: AIToolCall }

interface Waiter {
  resolve(r: AIProtocolResult): void
  reject(err: unknown): void
  onDelta?: (d: AIStreamDelta) => void
  off(): void
}

export interface ClaudeCliRunnerOptions {
  /** Claude ne dit plus rien (aucune ligne) : on abandonne. Defaut : 3 minutes. */
  silenceMs?: number
  /** Un outil rendu au moteur n'a pas de resultat : on abandonne. Defaut : 10 minutes. */
  toolWaitMs?: number
  newId?(): string
}

/** Une demande en cours : un programme claude, une conversation. */
class ClaudeSession {
  private readonly reader = new ClaudeStreamReader()
  private text = ''
  private model?: string
  private readonly usage = new Map<string, { input: number; output: number }>()
  private reported = { input: 0, output: 0 }
  private tools: AIToolDefinition[] = []
  private readonly queue: PendingCall[] = []
  private readonly handed = new Map<string, PendingCall>()
  private waiter: Waiter | null = null
  private limited = false
  private resetsAt?: number
  private failure?: { text: string; status?: number }
  private ended = false
  private stopped = false
  private silenceTimer?: ReturnType<typeof setTimeout>
  private waitTimer?: ReturnType<typeof setTimeout>

  constructor(
    private readonly runner: ClaudeCliRunner,
    private readonly transport: ClaudeCliTransport,
    readonly run: string,
    private readonly opts: Required<Pick<ClaudeCliRunnerOptions, 'silenceMs' | 'toolWaitMs'>> & { newId(): string },
  ) {}

  async begin(model: string, request: AIChatRequest): Promise<AIProtocolResult> {
    let asked: { system: string; prompt: string }
    try { asked = claudePrompt(request) } catch (err) { this.runner.forget(this); throw err }
    this.tools = request.tools ?? []
    const answer = this.wait(request)
    if (request.signal?.aborted) { this.runner.forget(this); return answer }
    try {
      await this.transport.start({ run: this.run, ...(model ? { model } : {}), ...asked, tools: this.tools.length > 0 }, e => this.onEvent(e))
      // Arretee pendant le lancement : le programme n'etait peut-etre pas encore la.
      if (this.stopped) void this.transport.cancel(this.run).catch(() => {})
      this.armSilence()
    } catch (err) {
      this.ended = true
      this.runner.forget(this)
      this.settle(null, new AIRequestError(messageOf(err)))
    }
    return answer
  }

  /** Le moteur rend les resultats des outils : ils repartent a Claude. */
  resume(request: AIChatRequest): Promise<AIProtocolResult> {
    const answer = this.wait(request)
    for (let i = request.messages.length - 1; i >= 0 && request.messages[i]!.role === 'tool'; i--) {
      const m = request.messages[i]!
      const pending = this.handed.get(m.toolCallId ?? '')
      if (!pending) continue
      this.release(pending)
      this.reply(pending.mcpId, toolText(pending.rpcId, m.content, false))
    }
    // Un appel reste sans resultat : Claude ne doit pas l'attendre.
    for (const pending of [...this.handed.values()]) {
      this.release(pending)
      this.reply(pending.mcpId, toolText(pending.rpcId, 'Aucun résultat pour cet outil.', true))
    }
    clearTimeout(this.waitTimer)
    this.armSilence()
    this.pump()
    return answer
  }

  private wait(request: AIChatRequest): Promise<AIProtocolResult> {
    return new Promise<AIProtocolResult>((resolve, reject) => {
      const signal = request.signal
      const onAbort = (): void => { this.settle(null, abortError()); this.stop() }
      this.waiter = { resolve, reject, ...(request.onDelta ? { onDelta: request.onDelta } : {}), off: () => signal?.removeEventListener('abort', onAbort) }
      if (signal?.aborted) return onAbort()
      signal?.addEventListener('abort', onAbort, { once: true })
    })
  }

  private settle(result: AIProtocolResult | null, err?: unknown): void {
    const w = this.waiter
    this.waiter = null
    clearTimeout(this.silenceTimer)
    if (!w) return
    w.off()
    if (result) w.resolve(result)
    else w.reject(err)
  }

  /** Les tokens depuis la derniere reponse rendue. */
  private segmentUsage(): AIProtocolResult['usage'] | undefined {
    let input = 0
    let output = 0
    for (const u of this.usage.values()) { input += u.input; output += u.output }
    const seg = { inputTokens: input - this.reported.input, outputTokens: output - this.reported.output }
    this.reported = { input, output }
    return seg.inputTokens || seg.outputTokens ? seg : undefined
  }

  private result(extra: Partial<AIProtocolResult> = {}): AIProtocolResult {
    const usage = this.segmentUsage()
    const r: AIProtocolResult = { text: this.text, ...(this.model ? { model: this.model } : {}), ...(usage ? { usage } : {}), ...extra }
    this.text = ''
    return r
  }

  private onEvent(e: ClaudeCliEvent): void {
    if (e.kind === 'mcp') return this.onMcp(e.id, e.body)
    if (e.kind === 'exit') return this.onExit(e)
    if (this.waiter) this.armSilence()
    for (const ev of this.reader.push(e.line)) {
      if (ev.type === 'text') {
        this.text += ev.text
        this.waiter?.onDelta?.({ text: ev.text })
      } else if (ev.type === 'usage') {
        this.usage.set(ev.messageId, { input: ev.inputTokens, output: ev.outputTokens })
      } else if (ev.type === 'model') {
        this.model = ev.model
      } else if (ev.type === 'limit') {
        this.limited = true
        if (ev.resetsAt) this.resetsAt = ev.resetsAt
      } else if (ev.ok) {
        // Rien n'est venu en morceaux : le texte du resultat.
        if (!this.text && ev.text) { this.text = ev.text; this.waiter?.onDelta?.({ text: ev.text }) }
        this.ended = true
        this.settle(this.result())
      } else {
        this.failure = { text: ev.text, ...(ev.status !== undefined ? { status: ev.status } : {}) }
        this.ended = true
        this.settle(null, new AIRequestError(this.failureMessage()))
      }
    }
  }

  private failureMessage(exit?: { code: number | null; reason: string; stderr: string }): string {
    return claudeErrorMessage({
      ...(this.failure ?? {}), limited: this.limited, ...(this.resetsAt ? { resetsAt: this.resetsAt } : {}),
      ...(exit ? { code: exit.code, reason: exit.reason, stderr: exit.stderr } : {}),
    })
  }

  private onExit(e: { code: number | null; reason: string; stderr: string }): void {
    this.ended = true
    clearTimeout(this.waitTimer)
    for (const p of [...this.queue.splice(0), ...this.handed.values()]) {
      this.release(p)
      this.reply(p.mcpId, toolText(p.rpcId, 'La demande à Claude est terminée.', true))
    }
    this.runner.forget(this)
    if (this.waiter) this.settle(null, e.reason === 'cancel' ? abortError() : new AIRequestError(this.failureMessage(e)))
  }

  private onMcp(id: number, body: string): void {
    let msg: { jsonrpc?: unknown; id?: RpcId; method?: unknown; params?: Record<string, unknown> }
    try { msg = JSON.parse(body) } catch { return this.reply(id, rpcFail(null, -32700, 'JSON illisible.')) }
    if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0') return this.reply(id, rpcFail(null, -32600, 'Requête JSON-RPC 2.0 attendue.'))
    // Notification : rien a rendre.
    if (typeof msg.method !== 'string' || !('id' in msg)) return this.reply(id, '')
    const rpcId: RpcId = typeof msg.id === 'string' || typeof msg.id === 'number' ? msg.id : null
    const params = msg.params && typeof msg.params === 'object' ? msg.params : {}
    switch (msg.method) {
      case 'initialize': {
        const asked = typeof params.protocolVersion === 'string' ? params.protocolVersion : ''
        return this.reply(id, rpcOk(rpcId, {
          protocolVersion: MCP_PROTOCOLS.includes(asked) ? asked : MCP_PROTOCOLS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'savoire', title: 'Savoire', version: '0.1.0' },
        }))
      }
      case 'ping': return this.reply(id, rpcOk(rpcId, {}))
      case 'tools/list':
        return this.reply(id, rpcOk(rpcId, { tools: this.tools.map(t => ({ name: t.name, description: t.description, inputSchema: t.parameters })) }))
      case 'tools/call': {
        const name = typeof params.name === 'string' ? params.name : ''
        if (!this.tools.some(t => t.name === name)) return this.reply(id, toolText(rpcId, `Outil inconnu ou non permis : ${name || '?'}.`, true))
        const args = params.arguments && typeof params.arguments === 'object' && !Array.isArray(params.arguments) ? params.arguments : {}
        const meta = params._meta && typeof params._meta === 'object' ? params._meta as Record<string, unknown> : {}
        let callId = typeof meta['claudecode/toolUseId'] === 'string' ? meta['claudecode/toolUseId'] as string : ''
        if (!callId || this.runner.has(callId)) callId = `claude-${this.opts.newId()}`
        this.queue.push({ mcpId: id, rpcId, call: { id: callId, name, arguments: JSON.stringify(args) } })
        return this.pump()
      }
      default:
        return this.reply(id, rpcFail(rpcId, -32601, `Méthode inconnue : ${msg.method}.`))
    }
  }

  /** Des appels d'outils attendent et une demande est la : ils partent au moteur. */
  private pump(): void {
    if (!this.waiter || !this.queue.length) return
    const calls = this.queue.splice(0)
    for (const p of calls) {
      this.handed.set(p.call.id, p)
      this.runner.hold(p.call.id, this)
    }
    calls.forEach((p, index) => this.waiter?.onDelta?.({ toolCall: { index, name: p.call.name, arguments: p.call.arguments } }))
    this.settle(this.result({ toolCalls: calls.map(p => p.call) }))
    // Le moteur execute les outils (et attend peut-etre un accord) : pas plus de toolWaitMs.
    clearTimeout(this.waitTimer)
    this.waitTimer = setTimeout(() => this.stop(), this.opts.toolWaitMs)
  }

  private release(p: PendingCall): void {
    this.handed.delete(p.call.id)
    this.runner.release(p.call.id)
  }

  private reply(id: number, body: string): void {
    void this.transport.replyMcp(id, body).catch(() => {})
  }

  private armSilence(): void {
    clearTimeout(this.silenceTimer)
    if (!this.waiter || this.ended) return
    this.silenceTimer = setTimeout(() => {
      this.settle(null, new AIRequestError(`Claude ne répond plus depuis ${Math.round(this.opts.silenceMs / 60000) || 1} min : la demande est arrêtée.`))
      this.stop()
    }, this.opts.silenceMs)
  }

  /** Arrete le programme. Sa fin (exit) libere le reste. */
  stop(): void {
    this.stopped = true
    clearTimeout(this.waitTimer)
    clearTimeout(this.silenceTimer)
    void this.transport.cancel(this.run).catch(() => {})
  }
}

/**
 * Le protocole « claude-cli » pour AIService. Une demande = un programme
 * claude ; elle dure tant que le moteur rend les resultats des outils.
 */
export class ClaudeCliRunner implements AIRunner {
  readonly protocol = CLAUDE_CLI_PROTOCOL
  readonly program: AIProgram
  /** Appel d'outil rendu au moteur → la demande qui attend son resultat. */
  private readonly waiting = new Map<string, ClaudeSession>()
  private readonly sessions = new Set<ClaudeSession>()
  private readonly opts: Required<Pick<ClaudeCliRunnerOptions, 'silenceMs' | 'toolWaitMs'>> & { newId(): string }

  constructor(private readonly transport: ClaudeCliTransport, opts: ClaudeCliRunnerOptions = {}) {
    this.opts = { silenceMs: opts.silenceMs ?? 180_000, toolWaitMs: opts.toolWaitMs ?? 600_000, newId: opts.newId ?? uuid }
    this.program = {
      status: () => transport.status(),
      choose: () => transport.choose(false),
      forget: () => transport.choose(true),
    }
  }

  async chat({ model, request }: AIRunnerCall): Promise<AIProtocolResult> {
    const session = this.sessionFor(request.messages)
    if (session) return session.resume(request)
    const fresh = new ClaudeSession(this, this.transport, this.opts.newId(), this.opts)
    this.sessions.add(fresh)
    return fresh.begin(model, request)
  }

  async listModels(): Promise<string[]> {
    return [...CLAUDE_CLI_MODELS]
  }

  /** Demandes en cours (tests, fermeture). */
  get active(): number {
    return this.sessions.size
  }

  /** Arrete toutes les demandes (fermeture de la fenetre). */
  stopAll(): void {
    for (const s of this.sessions) s.stop()
  }

  /** La demande qui attend un des resultats d'outils de la fin de la conversation. */
  private sessionFor(messages: AIMessage[]): ClaudeSession | undefined {
    for (let i = messages.length - 1; i >= 0 && messages[i]!.role === 'tool'; i--) {
      const s = this.waiting.get(messages[i]!.toolCallId ?? '')
      if (s) return s
    }
    return undefined
  }

  has(callId: string): boolean { return this.waiting.has(callId) }
  hold(callId: string, s: ClaudeSession): void { this.waiting.set(callId, s) }
  release(callId: string): void { this.waiting.delete(callId) }

  forget(s: ClaudeSession): void {
    this.sessions.delete(s)
    for (const [id, x] of this.waiting) if (x === s) this.waiting.delete(id)
  }
}
