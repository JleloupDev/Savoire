// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Le moteur des agents (ADR-033) : une boucle simple, structuree pour les
// sous-agents.
//
// Une execution (AgentRun) est un arbre d'etapes : appel au modele, appel
// d'outil, demande d'accord, delegation. Chaque etape garde ses tokens et sa
// duree. La v1 : l'IA demande un outil, la ToolBox verifie et l'execute, on
// recommence jusqu'a la reponse ou la fin du budget.
//
// Sous-agents : delegate() lance une execution ENFANT, attachee a une etape
// du parent, avec au plus les droits du parent (narrowAgent). Un
// orchestrateur sera un agent qui a le droit de deleguer.
import {
  AGENT_ACTIONS,
  type AIChatRequest, type AIChatResponse, type AIMessage, type AgentDefinition, type ToolActor, type ToolSource,
} from '@savoire/plugin-api'
import { ACTION_LABELS, MODE_LABELS, effectiveMode, narrowAgent, type PersonRights } from './policy'
import type { ToolBox } from './toolbox'

export type AgentStepKind = 'model' | 'tool' | 'approval' | 'delegate'
export type AgentStepStatus = 'running' | 'done' | 'error' | 'refused' | 'pending'

export interface AgentUsage {
  inputTokens: number
  outputTokens: number
}

export interface AgentStep {
  id: string
  /** Etape parente (une delegation contient l'execution enfant). */
  parentId?: string
  kind: AgentStepKind
  /** Outil appele, ou modele. */
  name?: string
  args?: Record<string, unknown>
  /** Resultat (outil) ou reponse (modele), abrege. */
  text?: string
  status: AgentStepStatus
  /** Mode applique a l'outil (direct, ask, propose). */
  mode?: string
  startedAt: string
  endedAt?: string
  usage?: AgentUsage
  /** Delegation : l'execution enfant. */
  childRunId?: string
}

export type AgentRunStatus = 'running' | 'done' | 'failed' | 'stopped' | 'budget'

export interface AgentRun {
  id: string
  agentId: string
  agentName: string
  userId: string
  parentRunId?: string
  parentStepId?: string
  input: string
  answer?: string
  error?: string
  status: AgentRunStatus
  startedAt: string
  endedAt?: string
  steps: AgentStep[]
  usage: AgentUsage
  sources: ToolSource[]
  model?: string
  connection?: string
  children?: AgentRun[]
}

export interface EngineDeps {
  agent: AgentDefinition
  person: PersonRights
  actor: ToolActor
  tools: ToolBox
  chat(request: AIChatRequest): Promise<AIChatResponse>
  /** Tokens deja consommes aujourd'hui par cet agent (budget du jour). */
  usedToday?: number
  /** A chaque changement de l'execution (pour l'ecran). */
  onUpdate?(run: AgentRun): void
  /** Pour deleguer : les dependances d'un sous-agent (ses outils, sa connexion). */
  forChild?(agent: AgentDefinition): EngineDeps
  now?(): Date
  newId?(): string
}

export const DEFAULT_MAX_STEPS = 20
/** Un resultat d'outil plus long est coupe avant d'etre rendu au modele. */
const MAX_TOOL_TEXT = 24_000

function uuid(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `id-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

/** Les consignes systeme : qui est l'agent, pour qui il agit, ce qu'il peut faire. */
export function systemPrompt(agent: AgentDefinition, actor: ToolActor, person: PersonRights): string {
  const rights = AGENT_ACTIONS.map(a => `- ${ACTION_LABELS[a]} : ${MODE_LABELS[effectiveMode(agent, a, person)]}`).join('\n')
  const scope = agent.scope?.folders?.length ? `\nTu ne travailles que dans ces dossiers : ${agent.scope.folders.join(', ')}.` : ''
  return [
    `Tu es « ${agent.name} », un agent de Savoire (des notes Markdown rangées dans un vault). Tu agis pour ${actor.onBehalfOf.displayName}.`,
    'Cherche et lis avant de répondre (search, read_note...). Ne devine pas le contenu d’une note.',
    'Quand tu t’appuies sur une note, cite-la avec un lien [[chemin de la note]].',
    'Si une action est refusée ou en attente, dis-le simplement et ne la refais pas.',
    `Tes droits :\n${rights}${scope}`,
    agent.instructions.trim() ? `\nConsignes :\n${agent.instructions.trim()}` : '',
  ].filter(Boolean).join('\n')
}

function parseArgs(raw: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(raw || '{}') as unknown
    return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null
  } catch {
    return null
  }
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n[… coupé : ${text.length - max} caractères de plus]` : text
}

export class AgentEngine {
  private readonly now: () => Date
  private readonly newId: () => string

  constructor(private readonly deps: EngineDeps) {
    this.now = deps.now ?? (() => new Date())
    this.newId = deps.newId ?? uuid
  }

  get agent(): AgentDefinition {
    return this.deps.agent
  }

  /** Une execution : la demande, et l'historique de la conversation s'il y en a un. */
  async run(input: string, opts: { history?: AIMessage[]; signal?: AbortSignal; parentRunId?: string; parentStepId?: string } = {}): Promise<AgentRun> {
    const { agent, actor, person, tools } = this.deps
    const run: AgentRun = {
      id: this.newId(), agentId: agent.id, agentName: agent.name, userId: actor.onBehalfOf.userId,
      input, status: 'running', startedAt: this.now().toISOString(), steps: [], usage: { inputTokens: 0, outputTokens: 0 }, sources: [],
      ...(opts.parentRunId ? { parentRunId: opts.parentRunId } : {}), ...(opts.parentStepId ? { parentStepId: opts.parentStepId } : {}),
    }
    const update = (): void => this.deps.onUpdate?.({ ...run, steps: [...run.steps], sources: [...run.sources] })
    const maxSteps = Math.max(1, Math.min(100, agent.budget?.maxSteps ?? DEFAULT_MAX_STEPS))
    const messages: AIMessage[] = [
      { role: 'system', content: systemPrompt(agent, actor, person) },
      ...(opts.history ?? []),
      { role: 'user', content: input },
    ]
    const definitions = tools.definitions()
    update()
    try {
      for (let i = 0; i < maxSteps; i++) {
        const budget = this.overBudget(run)
        if (budget) return this.finish(run, 'budget', update, budget)
        const step = this.step(run, 'model', { name: agent.model })
        update()
        const answer = await this.deps.chat({ messages, ...(definitions.length ? { tools: definitions } : {}), ...(agent.model ? { model: agent.model } : {}), ...(opts.signal ? { signal: opts.signal } : {}) })
        run.model = answer.model
        run.connection = answer.connection
        const usage = { inputTokens: answer.usage?.inputTokens ?? 0, outputTokens: answer.usage?.outputTokens ?? 0 }
        run.usage.inputTokens += usage.inputTokens
        run.usage.outputTokens += usage.outputTokens
        this.end(step, 'done', clip(answer.text, 2000), usage)
        const calls = answer.toolCalls ?? []
        if (!calls.length) {
          run.answer = answer.text
          return this.finish(run, 'done', update)
        }
        messages.push({ role: 'assistant', content: answer.text, toolCalls: calls })
        for (const call of calls) {
          const args = parseArgs(call.arguments)
          const ts = this.step(run, 'tool', { name: call.name, ...(args ? { args } : {}) })
          update()
          if (!args) {
            this.end(ts, 'error', 'Arguments illisibles (JSON attendu).')
            messages.push({ role: 'tool', toolCallId: call.id, content: 'Erreur : arguments illisibles, JSON attendu.' })
            continue
          }
          const outcome = await tools.call(call.name, args, opts.signal)
          ts.mode = outcome.mode
          const status: AgentStepStatus = outcome.approval === 'refused' ? 'refused' : outcome.approval === 'pending' ? 'pending' : outcome.result.isError ? 'error' : 'done'
          this.end(ts, status, clip(outcome.result.text, 2000))
          for (const s of outcome.result.sources ?? []) if (!run.sources.some(x => x.docId === s.docId)) run.sources.push(s)
          messages.push({ role: 'tool', toolCallId: call.id, content: clip(outcome.result.text, MAX_TOOL_TEXT) })
          update()
        }
      }
      return this.finish(run, 'stopped', update, `Limite de ${maxSteps} étapes atteinte.`)
    } catch (err) {
      if ((err as { name?: string })?.name === 'AbortError') return this.finish(run, 'stopped', update, 'Arrêté.')
      return this.finish(run, 'failed', update, err instanceof Error ? err.message : String(err))
    }
  }

  /**
   * Confie une tache a un sous-agent. Il n'a jamais plus de droits que cet
   * agent ; son execution est rattachee a une etape « delegate » du parent.
   */
  async delegate(parent: AgentRun, child: AgentDefinition, task: string, signal?: AbortSignal): Promise<AgentRun> {
    if (!this.deps.forChild) throw new Error('cet agent ne sait pas déléguer')
    const narrowed = narrowAgent(this.deps.agent, child)
    const step = this.step(parent, 'delegate', { name: narrowed.name, args: { task } })
    const engine = new AgentEngine({ ...this.deps.forChild(narrowed), now: this.now, newId: this.newId })
    const childRun = await engine.run(task, { parentRunId: parent.id, parentStepId: step.id, ...(signal ? { signal } : {}) })
    step.childRunId = childRun.id
    parent.usage.inputTokens += childRun.usage.inputTokens
    parent.usage.outputTokens += childRun.usage.outputTokens
    parent.children = [...(parent.children ?? []), childRun]
    this.end(step, childRun.status === 'done' ? 'done' : 'error', clip(childRun.answer ?? childRun.error ?? '', 2000), childRun.usage)
    return childRun
  }

  private overBudget(run: AgentRun): string | null {
    const b = this.deps.agent.budget
    const used = run.usage.inputTokens + run.usage.outputTokens
    if (b?.maxTokensPerRun && used >= b.maxTokensPerRun) return `Budget de l’exécution atteint (${b.maxTokensPerRun} tokens).`
    if (b?.maxTokensPerDay && (this.deps.usedToday ?? 0) + used >= b.maxTokensPerDay) return `Budget du jour atteint (${b.maxTokensPerDay} tokens).`
    return null
  }

  private step(run: AgentRun, kind: AgentStepKind, extra: Partial<AgentStep>): AgentStep {
    const s: AgentStep = { id: this.newId(), kind, status: 'running', startedAt: this.now().toISOString(), ...extra }
    run.steps.push(s)
    return s
  }

  private end(step: AgentStep, status: AgentStepStatus, text: string, usage?: AgentUsage): void {
    step.status = status
    step.text = text
    step.endedAt = this.now().toISOString()
    if (usage) step.usage = usage
  }

  private finish(run: AgentRun, status: AgentRunStatus, update: () => void, error?: string): AgentRun {
    run.status = status
    run.endedAt = this.now().toISOString()
    if (error) run.error = error
    for (const s of run.steps) if (s.status === 'running') this.end(s, 'error', s.text ?? '')
    update()
    return run
  }
}
