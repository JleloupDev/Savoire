// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Ou vivent les agents declares (ADR-033), et ce que le serveur sait d'eux.
//  - Profil serveur : /api/v1/agents (le serveur en a besoin pour verifier
//    les droits de ChatGPT et des autres IA externes).
//  - Profil local : dans le navigateur, par compte.
//
// Le serveur garde aussi la consommation par jour, les actions en attente
// d'accord (mode « demander » depuis l'exterieur) et le journal des actions
// externes. Le profil local n'a rien de tout ca : ses compteurs restent ici.
import type { AgentDefinition } from '@savoire/plugin-api'

export interface AgentUsageDay {
  agentId: string
  day: string
  inputTokens: number
  outputTokens: number
  runs: number
  calls: number
}

export interface AgentApproval {
  id: string
  agentId: string
  agentName: string
  vaultId: string
  tool: string
  args: Record<string, unknown>
  summary: string
  status: 'pending' | 'approved' | 'refused' | 'failed' | 'done'
  createdAt: string
  decidedAt?: string
  result?: string
}

export interface AgentAction {
  id: string
  agentId: string
  agentName: string
  vaultId: string
  tool: string
  action: string
  mode: string
  status: string
  summary: string
  createdAt: string
}

export type AgentDraft = Omit<AgentDefinition, 'id' | 'ownerId' | 'createdAt' | 'updatedAt'> & { id?: string }

export interface AgentDirectory {
  readonly kind: 'server' | 'local'
  list(): Promise<AgentDefinition[]>
  save(draft: AgentDraft): Promise<AgentDefinition>
  remove(id: string): Promise<void>
  /** Une execution dans l'appli a consomme ces tokens. */
  reportUsage(agentId: string, usage: { inputTokens: number; outputTokens: number; calls: number }): Promise<void>
  usage(days?: number): Promise<AgentUsageDay[]>
  approvals(): Promise<AgentApproval[]>
  decide(id: string, approve: boolean): Promise<AgentApproval>
  actions(limit?: number): Promise<AgentAction[]>
}

const today = (): string => new Date().toISOString().slice(0, 10)

async function problem(res: Response): Promise<Error> {
  const p = await res.json().catch(() => null) as { detail?: string; title?: string; errors?: Record<string, string[]> } | null
  const first = p?.errors ? Object.values(p.errors).flat()[0] : undefined
  return new Error(first ?? p?.detail ?? p?.title ?? `Erreur ${res.status}`)
}

export class ServerAgentDirectory implements AgentDirectory {
  readonly kind = 'server' as const

  constructor(private readonly token: () => string, private readonly url: (path: string) => string) {}

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(this.url(`/api/v1/agents${path}`), {
      method,
      headers: { Authorization: `Bearer ${this.token()}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
    if (!res.ok) throw await problem(res)
    return (res.status === 204 ? undefined : await res.json()) as T
  }

  async list(): Promise<AgentDefinition[]> {
    return (await this.call<{ agents: AgentDefinition[] }>('GET', '')).agents
  }

  save(draft: AgentDraft): Promise<AgentDefinition> {
    const { id, ...body } = draft
    return id ? this.call('PUT', `/${encodeURIComponent(id)}`, body) : this.call('POST', '', body)
  }

  remove(id: string): Promise<void> {
    return this.call('DELETE', `/${encodeURIComponent(id)}`)
  }

  reportUsage(agentId: string, usage: { inputTokens: number; outputTokens: number; calls: number }): Promise<void> {
    return this.call('POST', `/${encodeURIComponent(agentId)}/usage`, { ...usage, runs: 1 })
  }

  async usage(days = 30): Promise<AgentUsageDay[]> {
    return (await this.call<{ days: AgentUsageDay[] }>('GET', `/usage?days=${days}`)).days
  }

  async approvals(): Promise<AgentApproval[]> {
    return (await this.call<{ approvals: AgentApproval[] }>('GET', '/approvals')).approvals
  }

  decide(id: string, approve: boolean): Promise<AgentApproval> {
    return this.call('POST', `/approvals/${encodeURIComponent(id)}/decide`, { approve })
  }

  async actions(limit = 100): Promise<AgentAction[]> {
    return (await this.call<{ actions: AgentAction[] }>('GET', `/actions?limit=${limit}`)).actions
  }
}

type Storage_ = Pick<Storage, 'getItem' | 'setItem'>

export class LocalAgentDirectory implements AgentDirectory {
  readonly kind = 'local' as const

  constructor(private readonly storage: Storage_, private readonly accountId: string) {}

  private get key(): string { return `savoire-agents:${this.accountId}` }
  private get usageKey(): string { return `savoire-agent-usage:${this.accountId}` }

  private read<T>(key: string): T[] {
    try { return JSON.parse(this.storage.getItem(key) ?? '[]') as T[] } catch { return [] }
  }

  async list(): Promise<AgentDefinition[]> {
    return this.read<AgentDefinition>(this.key)
  }

  async save(draft: AgentDraft): Promise<AgentDefinition> {
    const all = this.read<AgentDefinition>(this.key)
    const now = new Date().toISOString()
    const prev = draft.id ? all.find(a => a.id === draft.id) : undefined
    const def: AgentDefinition = { ...draft, id: draft.id ?? crypto.randomUUID(), ownerId: this.accountId, createdAt: prev?.createdAt ?? now, updatedAt: now }
    this.storage.setItem(this.key, JSON.stringify([...all.filter(a => a.id !== def.id), def]))
    return def
  }

  async remove(id: string): Promise<void> {
    this.storage.setItem(this.key, JSON.stringify(this.read<AgentDefinition>(this.key).filter(a => a.id !== id)))
  }

  async reportUsage(agentId: string, u: { inputTokens: number; outputTokens: number; calls: number }): Promise<void> {
    const day = today()
    const all = this.read<AgentUsageDay>(this.usageKey)
    const row = all.find(r => r.agentId === agentId && r.day === day) ?? { agentId, day, inputTokens: 0, outputTokens: 0, runs: 0, calls: 0 }
    row.inputTokens += u.inputTokens; row.outputTokens += u.outputTokens; row.calls += u.calls; row.runs += 1
    const cutoff = new Date(Date.now() - 90 * 86_400_000).toISOString().slice(0, 10)
    this.storage.setItem(this.usageKey, JSON.stringify([...all.filter(r => r !== row && r.day >= cutoff), row]))
  }

  async usage(days = 30): Promise<AgentUsageDay[]> {
    const cutoff = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10)
    return this.read<AgentUsageDay>(this.usageKey).filter(r => r.day >= cutoff)
  }

  async approvals(): Promise<AgentApproval[]> { return [] }
  async decide(): Promise<AgentApproval> { throw new Error('Pas d’accord en attente en profil local.') }
  async actions(): Promise<AgentAction[]> { return [] }
}

// ── Le repertoire du compte actif ──────────────────────────────────────────

let current: AgentDirectory | null = null
const listeners = new Set<() => void>()

function storage(): Storage_ {
  try { return window.localStorage } catch { return { getItem: () => null, setItem: () => {} } }
}

let currentKey: string | null = null

/**
 * Le compte ou le profil change (AppShell, a chaque rendu) : rien ne se passe
 * tant que le compte et le profil restent les memes.
 */
export function setAgentDirectory(params: { kind: 'server'; accountId: string; token: () => string; url: (path: string) => string } | { kind: 'local'; accountId: string } | null): void {
  const key = params ? `${params.kind}:${params.accountId}` : null
  if (key === currentKey) return
  currentKey = key
  current = !params ? null : params.kind === 'server' ? new ServerAgentDirectory(params.token, params.url) : new LocalAgentDirectory(storage(), params.accountId)
  for (const cb of listeners) cb()
}

export function agentDirectory(): AgentDirectory | null {
  return current
}

export function onAgentDirectoryChange(cb: () => void): () => void {
  listeners.add(cb)
  return () => { listeners.delete(cb) }
}

/** Les agents ont change (cree, modifie, supprime) : les ecrans se relisent. */
export function notifyAgentsChanged(): void {
  for (const cb of listeners) cb()
}

/** Tokens consommes aujourd'hui par un agent (budget du jour). */
export async function usedToday(agentId: string): Promise<number> {
  const day = today()
  const rows = await current?.usage(1).catch(() => [] as AgentUsageDay[]) ?? []
  return rows.filter(r => r.agentId === agentId && r.day === day).reduce((n, r) => n + r.inputTokens + r.outputTokens, 0)
}
