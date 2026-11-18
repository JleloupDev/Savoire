// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Lancer un agent dans l'appli (ADR-033) : ses outils (socle + plugins),
// filtres par ses droits et ceux de la personne, l'IA de la personne, et
// l'historique de ses executions (sur ce poste) avec leur consommation.
import { AgentEngine, ToolBox, type AgentRun, type ApprovalRequest, type ApprovalAnswer } from '@savoire/agent-core'
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
  api: (Pick<PluginAPI, 'search' | 'indexer' | 'query'> & { agents?: { tools(): PluginTool[] } }) | null
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
  const actor: ToolActor = { agentId: agent.id, agentName: agent.name, onBehalfOf: { userId: p.person.userId, displayName: p.person.displayName } }
  const person = { canWrite: p.person.canWrite }
  const host = new AppToolHost({ client: p.client, session: p.session, api: p.api })
  const pluginTools = p.api?.agents?.tools() ?? []
  const tools = new ToolBox({ agent, person, actor, runtime: 'app', host, pluginTools, approve: p.approve })
  const engine = new AgentEngine({
    agent, person, actor, tools,
    chat: req => aiService.chat(req, agent.connectionId),
    usedToday: await usedToday(agent.id),
    ...(p.onUpdate ? { onUpdate: p.onUpdate } : {}),
  })
  const run = await engine.run(p.input, { ...(p.history ? { history: p.history } : {}), ...(p.signal ? { signal: p.signal } : {}) })
  saveRun(p.person.userId, run)
  const calls = run.steps.filter(s => s.kind === 'tool').length
  await agentDirectory()?.reportUsage(agent.id, { inputTokens: run.usage.inputTokens, outputTokens: run.usage.outputTokens, calls }).catch(() => {})
  return run
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
