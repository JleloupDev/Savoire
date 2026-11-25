// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Claude avec l'abonnement de la personne, cote page (bureau seulement) : le
// pont vers la coquille (commandes claude_cli_*, evenement « claude-cli »,
// reponses MCP par mcp_local_reply). La lecture du flux et la conversation
// sont dans @savoire/application (claudeCli.ts) ; le programme est lance par
// apps/desktop/src-tauri/src/claude_cli.rs.
//
// Sans @tauri-apps/api (ce fichier entre dans le bundle web) : on parle au
// pont IPC de Tauri 2 directement, comme localMcpDesktop.ts.
import { ClaudeCliRunner, type AIProgramStatus, type ClaudeCliEvent, type ClaudeCliTransport } from '@savoire/application'

const EVENT = 'claude-cli'

interface Internals {
  invoke(cmd: string, args?: Record<string, unknown>): Promise<unknown>
  transformCallback?(cb: (e: unknown) => void, once?: boolean): number
}

function internals(scope: unknown): Internals {
  const i = (scope as { __TAURI_INTERNALS__?: Internals }).__TAURI_INTERNALS__
  if (!i) throw new Error('Coquille bureau absente.')
  return i
}

type Payload = ClaudeCliEvent & { run: string }

/** Le pont : une seule ecoute de l'evenement, distribuee par demande. */
export function tauriClaudeCliTransport(scope: unknown = globalThis): ClaudeCliTransport {
  const handlers = new Map<string, (e: ClaudeCliEvent) => void>()
  let listening: Promise<void> | null = null
  const listen = (): Promise<void> => {
    listening ??= (async () => {
      const i = internals(scope)
      if (!i.transformCallback) throw new Error('Pont d’évènements absent.')
      const handler = i.transformCallback((e: unknown) => {
        const p = (e as { payload?: Payload }).payload
        if (!p || typeof p.run !== 'string') return
        const h = handlers.get(p.run)
        if (!h) return
        if (p.kind === 'exit') handlers.delete(p.run)
        h(p)
      })
      await i.invoke('plugin:event|listen', { event: EVENT, target: { kind: 'Any' }, handler })
    })().catch(err => { listening = null; throw err })
    return listening
  }
  return {
    async start(req, onEvent) {
      await listen()
      handlers.set(req.run, onEvent)
      try {
        await internals(scope).invoke('claude_cli_start', { request: req })
      } catch (err) {
        handlers.delete(req.run)
        throw err instanceof Error ? err : new Error(String(err))
      }
    },
    cancel: async run => { await internals(scope).invoke('claude_cli_cancel', { run }) },
    replyMcp: async (id, body) => { await internals(scope).invoke('mcp_local_reply', { id, body }) },
    status: async () => await internals(scope).invoke('claude_cli_status') as AIProgramStatus,
    choose: async forget => await internals(scope).invoke('claude_cli_choose', { forget: forget === true }) as AIProgramStatus,
  }
}

/** Le protocole « claude-cli » de l'appli de bureau. */
export function desktopClaudeCliRunner(scope: unknown = globalThis): ClaudeCliRunner {
  return new ClaudeCliRunner(tauriClaudeCliTransport(scope))
}
