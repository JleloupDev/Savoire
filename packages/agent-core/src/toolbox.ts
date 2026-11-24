// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// La boite a outils d'UN agent, pour UNE execution (ADR-033) : les outils du
// socle et ceux des plugins, filtres par ses droits. C'est elle qui decide,
// a chaque appel, si l'outil s'execute, propose, attend un accord ou refuse.
//
// Une action interdite n'est meme pas proposee a l'IA. Une action « demander »
// passe par l'approbateur : dans l'appli, la personne repond ; sur le pair,
// le serveur a deja decide (il fixe le mode de l'appel).
//
// Changer de mode (request_mode, get_mode) : dans l'appli seulement, quand
// l'appelant sait enregistrer l'agent (saveAgent). La demande passe par
// l'approbateur, comme une action « demander ». Sur le pair, c'est le
// serveur qui offre ces outils (MCP).
import type {
  AIToolDefinition, AgentAction, AgentActionMode, AgentDefinition, PluginTool, ToolActor, ToolResult, ToolRuntime, ToolSpec,
} from '@savoire/plugin-api'
import { CORE_TOOLS, type CoreTool } from './coreTools'
import { HostError, type AgentToolHost } from './host'
import {
  ACTION_LABELS, GET_MODE_TOOL, REQUEST_MODE_TOOL, canRequestMode, effectiveMode, modeLabel, normalizePermissions, switchMode, writingModeLabel,
  type PersonRights, type WritingMode,
} from './policy'

export interface ApprovalRequest {
  tool: ToolSpec
  args: Record<string, unknown>
  /** Ce que l'agent veut faire, en une phrase. */
  summary: string
  actor: ToolActor
}

/** 'approved' : faire ; 'refused' : ne pas faire ; pending : mis en attente (accord plus tard). */
export type ApprovalAnswer = 'approved' | 'refused' | { pending: string }

export interface ToolBoxOptions {
  agent: AgentDefinition
  person: PersonRights
  actor: ToolActor
  /** Ou l'on s'execute : seuls les outils de ce runtime sont proposes. */
  runtime: ToolRuntime
  /** Les outils du socle s'appuient sur lui. Absent : pas d'outils du socle. */
  host?: AgentToolHost
  pluginTools?: readonly PluginTool[]
  /** Demande l'accord de la personne. Absent : une action « demander » est refusee. */
  approve?: (req: ApprovalRequest) => Promise<ApprovalAnswer>
  /**
   * Mode impose par l'appelant (le serveur, qui a deja verifie les droits et
   * recueilli l'accord) : il ne peut que restreindre.
   */
  imposedMode?: 'direct' | 'propose'
  /**
   * Enregistre l'agent apres un changement de mode accepte par la personne.
   * Present : les outils get_mode et request_mode existent (request_mode si
   * l'agent le permet). Jamais pour un sous-agent (ses droits sont reduits).
   */
  saveAgent?: (agent: AgentDefinition) => Promise<unknown>
}

export interface ToolCallOutcome {
  result: ToolResult
  action: AgentAction
  /** Mode applique ('ask' : la personne a ete consultee). */
  mode: AgentActionMode
  /** Reponse de la personne, s'il a fallu demander. */
  approval?: 'approved' | 'refused' | 'pending'
}

type Entry = { spec: ToolSpec; run: (args: Record<string, unknown>, mode: 'direct' | 'propose', signal?: AbortSignal) => Promise<ToolResult> }

export class ToolBox {
  private readonly entries = new Map<string, Entry>()
  /** L'agent, tel qu'apres un changement de mode accepte. */
  private agent: AgentDefinition

  constructor(private readonly o: ToolBoxOptions) {
    this.agent = o.agent
    if (o.host) {
      const host = o.host
      for (const t of CORE_TOOLS) this.add(t.spec, (args, mode) => t.run(args, { mode, actor: o.actor, host, scope: o.agent.scope }))
    }
    if (o.saveAgent && o.runtime === 'app' && !o.imposedMode) {
      const never = async (): Promise<ToolResult> => ({ text: '', isError: true })
      this.entries.set(GET_MODE_TOOL, { spec: GET_MODE_SPEC, run: never })
      if (canRequestMode(o.agent)) this.entries.set(REQUEST_MODE_TOOL, { spec: REQUEST_MODE_SPEC, run: never })
    }
    for (const t of o.pluginTools ?? []) {
      if (this.entries.has(t.spec.name)) continue // un plugin ne remplace pas un outil du socle
      this.add(t.spec, (args, mode, signal) => t.run(args, { mode, actor: o.actor, ...(signal ? { signal } : {}) }))
    }
  }

  private add(spec: ToolSpec, run: Entry['run']): void {
    const runtimes = spec.runtimes ?? ['app']
    if (!runtimes.includes(this.o.runtime)) return
    if (this.modeOf(spec.action) === 'deny') return
    this.entries.set(spec.name, { spec, run })
  }

  /** Mode de l'agent pour cette action, borne par la personne. */
  modeOf(action: AgentAction): AgentActionMode {
    return effectiveMode(this.agent, action, this.o.person)
  }

  /** Les outils permis a cet agent. */
  specs(): ToolSpec[] {
    return [...this.entries.values()].map(e => e.spec)
  }

  /** Les memes, au format du fournisseur d'IA. */
  definitions(): AIToolDefinition[] {
    return this.specs().map(s => ({ name: s.name, description: s.description, parameters: s.inputSchema }))
  }

  has(name: string): boolean {
    return this.entries.has(name)
  }

  async call(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<ToolCallOutcome> {
    const e = this.entries.get(name)
    if (!e) {
      return { action: 'read', mode: 'deny', result: { text: `Outil inconnu ou non permis : ${name}.`, isError: true } }
    }
    if (name === GET_MODE_TOOL) return { action: 'read', mode: 'direct', result: { text: this.describeMode() } }
    if (name === REQUEST_MODE_TOOL) return this.requestMode(args)
    const { spec } = e
    const mode = this.modeOf(spec.action)
    if (mode === 'deny') return { action: spec.action, mode, result: { text: `Droit refusé à cet agent : ${spec.title}.`, isError: true } }
    let run: 'direct' | 'propose' = mode === 'propose' ? 'propose' : 'direct'
    if (this.o.imposedMode === 'propose') run = 'propose'
    let approval: ToolCallOutcome['approval']
    if (mode === 'ask' && !this.o.imposedMode) {
      const answer = this.o.approve ? await this.o.approve({ tool: spec, args, summary: summarize(spec, args), actor: this.o.actor }) : 'refused'
      if (answer === 'refused') {
        return { action: spec.action, mode, approval: 'refused', result: { text: 'La personne a refusé cette action. Ne la refaites pas ; proposez autre chose.', isError: true } }
      }
      if (typeof answer === 'object') {
        return { action: spec.action, mode, approval: 'pending', result: { text: 'Action en attente de validation dans Savoire. Elle sera faite quand la personne l’acceptera.', pending: { approvalId: answer.pending } } }
      }
      approval = 'approved'
    }
    try {
      const result = await e.run(args, run, signal)
      return { action: spec.action, mode, result, ...(approval ? { approval } : {}) }
    } catch (err) {
      if ((err as { name?: string })?.name === 'AbortError') throw err
      const message = err instanceof HostError || err instanceof Error ? err.message : String(err)
      return { action: spec.action, mode, result: { text: `Échec : ${message}`, isError: true }, ...(approval ? { approval } : {}) }
    }
  }

  /** Les modes de l'agent, en francais court (get_mode). */
  private describeMode(): string {
    const lines = (['edit', 'create'] as const).map(a => `- ${ACTION_LABELS[a]} : ${modeLabel(a, this.modeOf(a)).toLowerCase()}`)
    const end = canRequestMode(this.agent) ? 'Pour changer : request_mode, avec l’accord de la personne.' : 'Cet agent ne peut pas demander à changer de mode.'
    return [`« ${this.agent.name} » : ${writingModeLabel(this.agent, this.o.person)}.`, ...lines, end].join('\n')
  }

  /** request_mode : la personne accepte ou refuse ; accepte, l'agent est enregistre avec ses nouveaux modes. */
  private async requestMode(args: Record<string, unknown>): Promise<ToolCallOutcome> {
    const out = (text: string, extra: Partial<ToolCallOutcome> & { isError?: boolean } = {}): ToolCallOutcome => {
      const { isError, ...rest } = extra
      return { action: 'edit', mode: 'ask', ...rest, result: { text, ...(isError ? { isError } : {}) } }
    }
    const mode = args.mode
    if (mode !== 'direct' && mode !== 'propose') return out('mode : direct (édition) ou propose (révision).', { isError: true })
    const name = this.agent.name
    const now = normalizePermissions(this.agent.permissions)
    if (now.edit === 'deny' && now.create === 'deny') return out(`« ${name} » ne modifie ni ne crée de notes : il n’a pas de mode à changer.`, { isError: true })
    const next = switchMode(now, mode)
    const title = MODE_TITLES[mode]
    if (next.edit === now.edit && next.create === now.create) return out(`« ${name} » est déjà en mode ${title}.`)
    const reason = typeof args.reason === 'string' ? args.reason.trim().slice(0, 500) : ''
    const summary = `Passer en mode ${title}${reason ? ` : ${reason}` : ''}`
    const answer = this.o.approve ? await this.o.approve({ tool: REQUEST_MODE_SPEC, args, summary, actor: this.o.actor }) : 'refused'
    if (answer === 'refused') return out('La personne a refusé de changer de mode. Ne le redemandez pas : continuez dans le mode actuel.', { approval: 'refused', isError: true })
    if (typeof answer === 'object') return { action: 'edit', mode: 'ask', approval: 'pending', result: { text: 'Demande en attente de validation dans Savoire. Ne la refaites pas.', pending: { approvalId: answer.pending } } }
    const agent: AgentDefinition = { ...this.agent, permissions: next }
    try {
      await this.o.saveAgent?.(agent)
    } catch (err) {
      return out(`Échec : ${err instanceof Error ? err.message : String(err)}`, { approval: 'approved', isError: true })
    }
    this.agent = agent
    return out(`« ${name} » est maintenant en mode ${title}.`, { approval: 'approved' })
  }
}

const MODE_TITLES: Record<WritingMode, string> = {
  direct: 'édition (modifications directes)',
  propose: 'révision (modifications proposées dans Révision)',
}

const GET_MODE_SPEC: ToolSpec = {
  name: GET_MODE_TOOL, title: 'Mode de l’agent', action: 'read',
  description: 'Dit le mode de l’agent : édition (modifications directes), révision (propositions dans Révision) ou demander avant d’écrire.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
}

const REQUEST_MODE_SPEC: ToolSpec = {
  name: REQUEST_MODE_TOOL, title: 'Changer de mode', action: 'edit',
  description: 'Demande à passer en mode édition (direct : tes modifications s’appliquent) ou révision (propose : elles deviennent des propositions dans Révision). '
    + 'La personne accepte ou refuse ; si elle refuse, ne redemande pas.',
  inputSchema: {
    type: 'object',
    properties: {
      mode: { type: 'string', enum: ['direct', 'propose'], description: 'direct : édition ; propose : révision.' },
      reason: { type: 'string', description: 'Pourquoi changer de mode, en une phrase (montré à la personne).' },
    },
    required: ['mode', 'reason'],
    additionalProperties: false,
  },
}

/** « Déplacer ou renommer : path=Inbox/a.md, to=Archives/ ». */
export function summarize(spec: ToolSpec, args: Record<string, unknown>): string {
  const parts = Object.entries(args)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${k}=${typeof v === 'string' ? (v.length > 120 ? `${v.slice(0, 120)}…` : v) : JSON.stringify(v).slice(0, 120)}`)
  return `${spec.title}${parts.length ? ` : ${parts.join(', ')}` : ''}`
}

/** Le catalogue du socle (fiches seulement), pour un runtime. */
export function coreCatalog(runtime: ToolRuntime): ToolSpec[] {
  return CORE_TOOLS.map((t: CoreTool) => t.spec).filter(s => (s.runtimes ?? ['app']).includes(runtime))
}
