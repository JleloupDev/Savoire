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
// orchestrateur est un agent qui a le droit 'delegate' et une liste
// `delegates` : l'IA recoit alors l'outil delegate { agent, task }.
// Profondeur 3 au plus, jamais soi-meme, un budget par enfant ; les tokens
// des enfants remontent au parent.
//
// Flux : chat() recoit onDelta, le texte de l'etape du modele grandit au fil
// de l'eau et onUpdate suit.
import {
  AGENT_ACTIONS,
  type AIChatRequest, type AIChatResponse, type AIMessage, type AIToolDefinition, type AgentDefinition, type ToolActor, type ToolSource,
} from '@savoire/plugin-api'
import { ACTION_LABELS, MAX_DELEGATION_DEPTH, delegableAgents, effectiveMode, modeLabel, narrowAgent, type PersonRights } from './policy'
import type { ApprovalAnswer, ApprovalRequest, ToolBox } from './toolbox'

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
  /**
   * Les agents connus, parmi lesquels l'orchestrateur choisit (sa liste
   * `delegates`). Sans eux, ou sans forChild, l'outil delegate n'existe pas.
   */
  agents?: readonly AgentDefinition[]
  /** Accord de la personne pour une delegation en mode « demander ». */
  approve?(req: ApprovalRequest): Promise<ApprovalAnswer>
  /** Profondeur de cet agent dans la delegation (0 : celui qu'on a lance). */
  depth?: number
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
  const rights = AGENT_ACTIONS.map(a => `- ${ACTION_LABELS[a]} : ${modeLabel(a, effectiveMode(agent, a, person))}`).join('\n')
  const scope = agent.scope?.folders?.length ? `\nTu ne travailles que dans ces dossiers : ${agent.scope.folders.join(', ')}.` : ''
  return [
    `Tu es « ${agent.name} », un agent de Savoire (des notes Markdown rangées dans un vault). Tu agis pour ${actor.onBehalfOf.displayName}.`,
    'Cherche et lis avant de répondre (search, read_note...). Ne devine pas le contenu d’une note.',
    'Ne relis pas une note entière : read_note sait rendre une section, des lignes, ou seulement ce qui a changé (since).',
    effectiveMode(agent, 'edit', person) === 'deny' ? '' : 'Pour écrire, retouche un bloc avec patch_note plutôt que de réécrire la note.',
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

/** Nom de l'outil de delegation (reserve : aucun outil de plugin ne le prend). */
export const DELEGATE_TOOL = 'delegate'

function delegateDefinition(agents: readonly AgentDefinition[]): AIToolDefinition {
  return {
    name: DELEGATE_TOOL,
    description: 'Confie une tâche à un sous-agent et rend sa réponse. Donne-lui une consigne complète : il ne voit pas cette conversation. Sous-agents : '
      + agents.map(a => `« ${a.name} » (id ${a.id})${a.description ? ` : ${a.description}` : ''}`).join(' ; ') + '.',
    parameters: {
      type: 'object',
      properties: {
        agent: { type: 'string', description: 'Id ou nom du sous-agent.' },
        task: { type: 'string', description: 'La tâche, complète et autonome.' },
      },
      required: ['agent', 'task'],
      additionalProperties: false,
    },
  }
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

  /** Les sous-agents permis a cet agent, ici et maintenant ([] : pas d'outil delegate). */
  delegates(): AgentDefinition[] {
    const { agent, person, forChild, agents } = this.deps
    if (!forChild || !agents?.length) return []
    if ((this.deps.depth ?? 0) >= MAX_DELEGATION_DEPTH) return []
    if (effectiveMode(agent, 'delegate', person) === 'deny') return []
    return delegableAgents(agent, agents)
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
    const delegates = this.delegates()
    const definitions = [...tools.definitions().filter(d => d.name !== DELEGATE_TOOL), ...(delegates.length ? [delegateDefinition(delegates)] : [])]
    this.liveUpdate = update
    update()
    try {
      for (let i = 0; i < maxSteps; i++) {
        const budget = this.overBudget(run)
        if (budget) return this.finish(run, 'budget', update, budget)
        const step = this.step(run, 'model', { name: agent.model })
        update()
        // Au fil de l'eau : le texte de l'etape grandit, l'ecran suit.
        let streamed = ''
        const onDelta = (d: { text?: string }): void => {
          if (!d.text) return
          streamed += d.text
          step.text = clip(streamed, 2000)
          update()
        }
        const answer = await this.deps.chat({ messages, ...(definitions.length ? { tools: definitions } : {}), ...(agent.model ? { model: agent.model } : {}), onDelta, ...(opts.signal ? { signal: opts.signal } : {}) })
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
          if (call.name === DELEGATE_TOOL && delegates.length) {
            const text = await this.delegateCall(run, delegates, parseArgs(call.arguments), update, opts.signal)
            messages.push({ role: 'tool', toolCallId: call.id, content: clip(text, MAX_TOOL_TEXT) })
            update()
            continue
          }
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

  /** L'outil delegate, demande par le modele : verifie, demande l'accord s'il le faut, lance le sous-agent. */
  private async delegateCall(run: AgentRun, delegates: AgentDefinition[], args: Record<string, unknown> | null, update: () => void, signal?: AbortSignal): Promise<string> {
    const wanted = typeof args?.agent === 'string' ? args.agent.trim() : ''
    const task = typeof args?.task === 'string' ? args.task.trim() : ''
    const fail = (text: string): string => {
      const s = this.step(run, 'delegate', { name: wanted || '?', ...(args ? { args } : {}) })
      this.end(s, 'error', text)
      return `Échec : ${text}`
    }
    if (!wanted || !task) return fail('donnez agent et task.')
    const child = delegates.find(a => a.id === wanted) ?? delegates.find(a => a.name.toLowerCase() === wanted.toLowerCase())
    if (!child) return fail(`sous-agent inconnu ou non permis : ${wanted}.`)
    if (effectiveMode(this.deps.agent, 'delegate', this.deps.person) === 'ask') {
      const answer = this.deps.approve
        ? await this.deps.approve({
          tool: { name: DELEGATE_TOOL, title: 'Confier une tâche', description: '', action: 'delegate', inputSchema: { type: 'object', properties: {} } },
          args: { agent: child.name, task }, summary: `Confier à « ${child.name} » : ${task.slice(0, 200)}`, actor: this.deps.actor,
        })
        : 'refused'
      if (answer !== 'approved') {
        const s = this.step(run, 'approval', { name: child.name, args: { task } })
        this.end(s, answer === 'refused' ? 'refused' : 'pending', '')
        return 'La personne a refusé cette délégation. Ne la refaites pas.'
      }
    }
    let childRun: AgentRun
    try {
      childRun = await this.delegate(run, child, task, signal, update)
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err))
    }
    if (childRun.status !== 'done') return `Le sous-agent « ${child.name} » n’a pas fini (${childRun.status}) : ${childRun.error ?? ''}`
    return `Réponse de « ${child.name} » :\n${childRun.answer ?? ''}`
  }

  /**
   * Confie une tache a un sous-agent. Il n'a jamais plus de droits que cet
   * agent ; son execution est rattachee a une etape « delegate » du parent.
   * Son budget : celui du parent pour un enfant (maxTokensPerChild), sinon
   * ce qui reste du budget de l'execution du parent. Ses tokens remontent.
   */
  async delegate(parent: AgentRun, child: AgentDefinition, task: string, signal?: AbortSignal, parentUpdate?: () => void): Promise<AgentRun> {
    if (!this.deps.forChild) throw new Error('cet agent ne sait pas déléguer')
    if (child.id === this.deps.agent.id) throw new Error('un agent ne se délègue pas à lui-même')
    const depth = (this.deps.depth ?? 0) + 1
    if (depth > MAX_DELEGATION_DEPTH) throw new Error(`délégation trop profonde (${MAX_DELEGATION_DEPTH} niveaux au plus)`)
    const narrowed = narrowAgent(this.deps.agent, child)
    const cap = this.childBudget(parent)
    if (cap !== undefined && cap <= 0) throw new Error('plus de budget pour un sous-agent')
    if (cap !== undefined) narrowed.budget = { ...narrowed.budget, maxTokensPerRun: Math.min(narrowed.budget?.maxTokensPerRun ?? cap, cap) }
    const step = this.step(parent, 'delegate', { name: narrowed.name, args: { task } })
    const notify = parentUpdate ?? this.liveUpdate
    // Pendant que l'enfant travaille, le parent montre son execution en direct.
    const live = (r: AgentRun): void => {
      step.childRunId = r.id
      parent.children = [...(parent.children ?? []).filter(c => c.id !== r.id), r]
      notify?.()
    }
    const childDeps = this.deps.forChild(narrowed)
    const engine = new AgentEngine({
      ...childDeps, depth, now: this.now, newId: this.newId,
      onUpdate: r => { childDeps.onUpdate?.(r); live(r) },
    })
    const childRun = await engine.run(task, { parentRunId: parent.id, parentStepId: step.id, ...(signal ? { signal } : {}) })
    step.childRunId = childRun.id
    parent.usage.inputTokens += childRun.usage.inputTokens
    parent.usage.outputTokens += childRun.usage.outputTokens
    parent.children = [...(parent.children ?? []).filter(c => c.id !== childRun.id), childRun]
    for (const src of childRun.sources) if (!parent.sources.some(x => x.docId === src.docId)) parent.sources.push(src)
    this.end(step, childRun.status === 'done' ? 'done' : 'error', clip(childRun.answer ?? childRun.error ?? '', 2000), childRun.usage)
    return childRun
  }

  /** Tokens permis a un enfant ; undefined : pas de plafond. */
  private childBudget(parent: AgentRun): number | undefined {
    const b = this.deps.agent.budget
    const used = parent.usage.inputTokens + parent.usage.outputTokens
    const left = b?.maxTokensPerRun ? Math.max(0, b.maxTokensPerRun - used) : undefined
    const perChild = b?.maxTokensPerChild
    if (perChild && left !== undefined) return Math.min(perChild, left)
    return perChild ?? left
  }

  /** L'ecran de l'execution en cours (pour les enfants). */
  private liveUpdate?: () => void

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
