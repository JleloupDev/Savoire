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
import type {
  AIToolDefinition, AgentAction, AgentActionMode, AgentDefinition, PluginTool, ToolActor, ToolResult, ToolRuntime, ToolSpec,
} from '@savoire/plugin-api'
import { CORE_TOOLS, type CoreTool } from './coreTools'
import { HostError, type AgentToolHost } from './host'
import { effectiveMode, type PersonRights } from './policy'

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

  constructor(private readonly o: ToolBoxOptions) {
    if (o.host) {
      const host = o.host
      for (const t of CORE_TOOLS) this.add(t.spec, (args, mode) => t.run(args, { mode, actor: o.actor, host, scope: o.agent.scope }))
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
    return effectiveMode(this.o.agent, action, this.o.person)
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
