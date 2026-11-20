// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// MCP local, cote page (bureau seulement) : les reglages (actif ou non,
// quel agent), le pont vers la coquille (commandes mcp_local_*, evenement
// « mcp-local-request ») et la file des accords « demander ».
//
// Sans @tauri-apps/api (ce fichier entre dans le bundle web) : on parle au
// pont IPC de Tauri 2 directement, comme noteWindow.ts et loginFlow.ts.
import type { ApprovalAnswer, ApprovalRequest } from '@savoire/agent-core'
import type { VaultClient } from '@savoire/platform'
import type { IVaultSyncSession } from '@savoire/application'
import { appToolBox, type RunParams } from './agentRunner'
import { agentDirectory } from './agentDirectory'
import { handleLocalMcp } from './localMcp'

const REQUEST_EVENT = 'mcp-local-request'
const STORAGE_KEY = 'savoire-mcp-local'

// ── Reglages (ce poste) ─────────────────────────────────────────────────────

export interface LocalMcpSettings {
  enabled: boolean
  /** L'agent dont le MCP local porte les droits. Aucun par defaut : rien ne marche tant qu'on n'en choisit pas. */
  agentId: string
}

export function readLocalMcpSettings(storage: Pick<Storage, 'getItem'> | null = safeStorage()): LocalMcpSettings {
  try {
    const v = JSON.parse(storage?.getItem(STORAGE_KEY) ?? '{}') as Partial<LocalMcpSettings>
    return { enabled: v.enabled === true, agentId: typeof v.agentId === 'string' ? v.agentId : '' }
  } catch {
    return { enabled: false, agentId: '' }
  }
}

export function writeLocalMcpSettings(s: LocalMcpSettings, storage: Pick<Storage, 'setItem'> | null = safeStorage()): void {
  try { storage?.setItem(STORAGE_KEY, JSON.stringify(s)) } catch { /* stockage indisponible : reglage perdu a la fermeture */ }
}

function safeStorage(): Storage | null {
  try { return window.localStorage } catch { return null }
}

// ── Pont vers la coquille ───────────────────────────────────────────────────

interface Internals {
  invoke(cmd: string, args?: Record<string, unknown>): Promise<unknown>
  transformCallback?(cb: (e: unknown) => void, once?: boolean): number
}

function internals(scope: unknown = globalThis): Internals {
  const i = (scope as { __TAURI_INTERNALS__?: Internals }).__TAURI_INTERNALS__
  if (!i) throw new Error('Coquille bureau absente.')
  return i
}

export interface McpLocalStatus {
  running: boolean
  port: number
  token: string
  url: string
  config_file: string
  exe: string
}

export const mcpLocalCommands = {
  start: (scope?: unknown) => internals(scope).invoke('mcp_local_start', {}) as Promise<McpLocalStatus>,
  stop: (scope?: unknown) => internals(scope).invoke('mcp_local_stop') as Promise<McpLocalStatus>,
  status: (scope?: unknown) => internals(scope).invoke('mcp_local_status') as Promise<McpLocalStatus>,
  newToken: (scope?: unknown) => internals(scope).invoke('mcp_local_new_token') as Promise<McpLocalStatus>,
}

/** Ecoute un evenement de la coquille (plugin:event|listen) ; rend de quoi arreter. */
export async function listenTauri(event: string, cb: (payload: unknown) => void, scope: unknown = globalThis): Promise<() => void> {
  const i = internals(scope)
  if (!i.transformCallback) throw new Error('Pont d’évènements absent.')
  const handler = i.transformCallback((e: unknown) => cb((e as { payload?: unknown }).payload))
  const eventId = await i.invoke('plugin:event|listen', { event, target: { kind: 'Any' }, handler }) as number
  return () => { void i.invoke('plugin:event|unlisten', { event, eventId }).catch(() => {}) }
}

// ── Accords « demander » ────────────────────────────────────────────────────

export interface LocalMcpApproval { req: ApprovalRequest; resolve(a: ApprovalAnswer): void }

const queue: LocalMcpApproval[] = []
const watchers = new Set<() => void>()
const changed = (): void => watchers.forEach(w => w())

/** Une action « demander » du MCP local : la fenetre de Savoire l'affiche et la personne repond. */
export function askLocalMcpApproval(req: ApprovalRequest): Promise<ApprovalAnswer> {
  return new Promise<ApprovalAnswer>(resolve => {
    queue.push({ req, resolve: a => { queue.splice(queue.findIndex(q => q.req === req), 1); changed(); resolve(a) } })
    changed()
  })
}

export function pendingLocalMcpApprovals(): readonly LocalMcpApproval[] { return queue }

export function onLocalMcpApprovals(cb: () => void): () => void {
  watchers.add(cb)
  return () => { watchers.delete(cb) }
}

// ── Service ─────────────────────────────────────────────────────────────────

/** Ce que l'appli ouverte met a disposition : le vault courant et la personne. */
export type LocalMcpContext = Pick<RunParams, 'vaultId' | 'person' | 'api'> & { client: VaultClient; session: IVaultSyncSession }

export interface LocalMcpServiceDeps {
  context(): LocalMcpContext | null
  settings?(): LocalMcpSettings
  /** Defaut : la file d'accords affichee par LocalMcpApprovals. */
  approve?(req: ApprovalRequest): Promise<ApprovalAnswer>
}

/** La boite d'outils de l'agent choisi : les memes droits que partout, au nom de la personne. */
export async function localMcpToolBox(deps: LocalMcpServiceDeps) {
  const settings = (deps.settings ?? readLocalMcpSettings)()
  if (!settings.enabled) throw new Error('Le MCP local est coupé dans Savoire (Paramètres → Agents → MCP local).')
  if (!settings.agentId) throw new Error('Aucun agent choisi pour le MCP local (Paramètres → Agents → MCP local).')
  const ctx = deps.context()
  if (!ctx) throw new Error('Aucun vault ouvert dans Savoire : ouvrez un vault pour que l’agent puisse y travailler.')
  const agent = (await agentDirectory()?.list().catch(() => []) ?? []).find(a => a.id === settings.agentId)
  if (!agent) throw new Error('L’agent choisi pour le MCP local n’existe plus : choisissez-en un autre.')
  return appToolBox({ ...ctx, agent, approve: deps.approve ?? askLocalMcpApproval })
}

/**
 * Relie le MCP local a la page : chaque message du client arrive par
 * l'evenement, la reponse repart par mcp_local_reply. Demarre le serveur si
 * le reglage est actif. Rend de quoi tout arreter.
 */
export async function startLocalMcpService(deps: LocalMcpServiceDeps, scope: unknown = globalThis): Promise<() => void> {
  const i = internals(scope)
  const stop = await listenTauri(REQUEST_EVENT, payload => {
    const { id, body } = payload as { id: number; body: string }
    void handleLocalMcp(body, { toolBox: () => localMcpToolBox(deps) })
      .catch(err => JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32603, message: err instanceof Error ? err.message : String(err) } }))
      .then(reply => i.invoke('mcp_local_reply', { id, body: reply }))
      .catch(() => {})
  }, scope)
  if ((deps.settings ?? readLocalMcpSettings)().enabled) await mcpLocalCommands.start(scope).catch(() => {})
  return stop
}
