// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Lancer un agent dans l'appli (ADR-033) : ses outils (socle + plugins),
// filtres par ses droits et ceux de la personne, l'IA de la personne, et
// l'historique de ses executions (sur ce poste) avec leur consommation.
import { AgentEngine, ToolBox, type AgentRun, type EngineDeps, type ApprovalRequest, type ApprovalAnswer } from '@savoire/agent-core'
import type { IVaultSyncSession } from '@savoire/application'
import type { VaultClient } from '@savoire/platform'
import type { AIMessage, AgentDefinition, PluginAPI, PluginTool, ToolActor } from '@savoire/plugin-api'
import { aiService } from '../aiService'
import { AppToolHost } from './appToolHost'
import { agentDirectory, usedToday } from './agentDirectory'

export interface RunParams {
  agent: AgentDefinition
  input: string
  history?: AIMessage[]
  person: { userId: string; displayName: string; canWrite: boolean }
  vaultId: string
  client: VaultClient
  session: IVaultSyncSession
  api: (Pick<PluginAPI, 'search' | 'indexer' | 'query'> & { agents?: { tools(): PluginTool[] }; vault?: { moveFiles?(moves: { from: string; to: string }[]): Promise<number> } }) | null
  /** Demande l'accord de la personne (mode « demander »). */
  approve: (req: ApprovalRequest) => Promise<ApprovalAnswer>
  onUpdate?: (run: AgentRun) => void
  signal?: AbortSignal
}

export async function runAgentInApp(p: RunParams): Promise<AgentRun> {
  const { agent } = p
  if (agent.scope?.vaultIds?.length && !agent.scope.vaultIds.includes(p.vaultId)) {
    throw new Error(`« ${agent.name} » n’a pas accès à ce vault.`)
  }
  if (agent.vaultId && agent.vaultId !== p.vaultId) throw new Error(`« ${agent.name} » est un agent d’un autre vault.`)
  if (!aiService.connections().length) throw new Error('Aucune IA configurée : ajoutez une connexion dans Paramètres → IA.')
  const person = { canWrite: p.person.canWrite }
  const moveFiles = p.api?.vault?.moveFiles?.bind(p.api.vault)
  const host = new AppToolHost({ client: p.client, session: p.session, api: p.api, ...(moveFiles ? { moveFiles } : {}) })
  const pluginTools = p.api?.agents?.tools() ?? []
  // Orchestrateur : les agents connus, et la consommation du jour de ceux
  // qu'on peut deleguer (forChild est synchrone, on la lit avant).
  const known = agent.delegates?.length ? await agentDirectory()?.list().catch(() => []) ?? [] : []
  const delegable = new Set(known.flatMap(a => a.delegates ?? []))
  const childUsage = new Map<string, number>()
  await Promise.all([...delegable].map(async id => { childUsage.set(id, await usedToday(id)) }))
  const depsFor = (a: AgentDefinition, used: number): EngineDeps => {
    const actor: ToolActor = { agentId: a.id, agentName: a.name, onBehalfOf: { userId: p.person.userId, displayName: p.person.displayName } }
    const tools = new ToolBox({ agent: a, person, actor, runtime: 'app', host, pluginTools, approve: p.approve })
    return {
      agent: a, person, actor, tools,
      chat: req => aiService.chat(req, a.connectionId),
      usedToday: used,
      ...(known.length ? { agents: known, forChild: (c: AgentDefinition) => depsFor(c, childUsage.get(c.id) ?? 0) } : {}),
      approve: p.approve,
    }
  }
  const engine = new AgentEngine({ ...depsFor(agent, await usedToday(agent.id)), ...(p.onUpdate ? { onUpdate: p.onUpdate } : {}) })
  const run = await engine.run(p.input, { ...(p.history ? { history: p.history } : {}), ...(p.signal ? { signal: p.signal } : {}) })
  saveRun(p.person.userId, run)
  await reportRunUsage(run)
  return run
}

/** Consommation de chaque agent : la sienne, sans celle de ses sous-agents (comptes a part). */
async function reportRunUsage(run: AgentRun): Promise<void> {
  const children = run.children ?? []
  const inputTokens = run.usage.inputTokens - children.reduce((n, c) => n + c.usage.inputTokens, 0)
  const outputTokens = run.usage.outputTokens - children.reduce((n, c) => n + c.usage.outputTokens, 0)
  const calls = run.steps.filter(s => s.kind === 'tool').length
  await agentDirectory()?.reportUsage(run.agentId, { inputTokens: Math.max(0, inputTokens), outputTokens: Math.max(0, outputTokens), calls }).catch(() => {})
  for (const c of children) await reportRunUsage(c)
}

// ── Historique des executions (ce poste) ───────────────────────────────────

const MAX_RUNS = 50

function storage(): Pick<Storage, 'getItem' | 'setItem'> | null {
  try { return window.localStorage } catch { return null }
}

const key = (userId: string): string => `savoire-agent-runs:${userId}`

export function listRuns(userId: string): AgentRun[] {
  try { return JSON.parse(storage()?.getItem(key(userId)) ?? '[]') as AgentRun[] } catch { return [] }
}

function saveRun(userId: string, run: AgentRun): void {
  const light: AgentRun = { ...run, steps: run.steps.map(s => ({ ...s, text: s.text?.slice(0, 500) })) }
  const all = [light, ...listRuns(userId).filter(r => r.id !== run.id)].slice(0, MAX_RUNS)
  try { storage()?.setItem(key(userId), JSON.stringify(all)) } catch { /* stockage plein : on garde l'execution en memoire seulement */ }
}

export function clearRuns(userId: string): void {
  storage()?.setItem(key(userId), '[]')
}
