// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Claude par l'abonnement, cote page : les commandes envoyees a la coquille
// et l'evenement « claude-cli » distribue par demande (pont IPC simule).
import { describe, it, expect } from 'vitest'
import type { ClaudeCliEvent } from '@savoire/application'
import { tauriClaudeCliTransport } from '../../../../../apps/web/src/claudeCliDesktop'

function fakeScope() {
  const calls: { cmd: string; args?: Record<string, unknown> }[] = []
  const callbacks = new Map<number, (e: unknown) => void>()
  let n = 0
  const scope = {
    __TAURI_INTERNALS__: {
      transformCallback: (cb: (e: unknown) => void) => { callbacks.set(++n, cb); return n },
      invoke: async (cmd: string, args?: Record<string, unknown>) => {
        calls.push({ cmd, ...(args ? { args } : {}) })
        if (cmd === 'claude_cli_start' && (args?.request as { prompt?: string }).prompt === 'refus') throw 'Claude Code est introuvable sur cet ordinateur.'
        if (cmd === 'claude_cli_status') return { found: true, path: '/usr/local/bin/claude', version: '2.1.0', chosen: false }
        return null
      },
    },
  }
  const emit = (payload: unknown) => { for (const cb of callbacks.values()) cb({ event: 'claude-cli', payload }) }
  return { scope, calls, emit }
}

describe('pont Claude du bureau', () => {
  it('lance, distribue la sortie a la bonne demande, repond au MCP, arrete', async () => {
    const { scope, calls, emit } = fakeScope()
    const t = tauriClaudeCliTransport(scope)
    const a: ClaudeCliEvent[] = []
    const b: ClaudeCliEvent[] = []
    await t.start({ run: 'r1', model: 'sonnet', system: 's', prompt: 'p', tools: true }, e => a.push(e))
    await t.start({ run: 'r2', system: '', prompt: 'q', tools: false }, e => b.push(e))
    // Une seule ecoute de l'evenement pour toutes les demandes.
    expect(calls.filter(c => c.cmd === 'plugin:event|listen')).toHaveLength(1)
    expect(calls.find(c => c.cmd === 'claude_cli_start')?.args).toEqual({ request: { run: 'r1', model: 'sonnet', system: 's', prompt: 'p', tools: true } })
    emit({ run: 'r1', kind: 'line', line: '{"type":"system"}' })
    emit({ run: 'r2', kind: 'mcp', id: 4, body: '{}' })
    emit({ run: 'inconnue', kind: 'line', line: 'x' })
    emit({ run: 'r1', kind: 'exit', code: 0, reason: 'exit', stderr: '' })
    emit({ run: 'r1', kind: 'line', line: 'apres la fin' })
    expect(a.map(e => e.kind)).toEqual(['line', 'exit'])
    expect(b).toEqual([{ run: 'r2', kind: 'mcp', id: 4, body: '{}' }])
    await t.replyMcp(4, '{"jsonrpc":"2.0"}')
    await t.cancel('r2')
    expect(calls.slice(-2)).toEqual([
      { cmd: 'mcp_local_reply', args: { id: 4, body: '{"jsonrpc":"2.0"}' } },
      { cmd: 'claude_cli_cancel', args: { run: 'r2' } },
    ])
  })

  it('une erreur de la coquille devient une Error lisible ; etat et choix du programme', async () => {
    const { scope, calls } = fakeScope()
    const t = tauriClaudeCliTransport(scope)
    await expect(t.start({ run: 'r', system: '', prompt: 'refus', tools: false }, () => {})).rejects.toThrow(/introuvable/)
    expect((await t.status()).path).toBe('/usr/local/bin/claude')
    await t.choose(true)
    await t.choose()
    expect(calls.filter(c => c.cmd === 'claude_cli_choose').map(c => c.args)).toEqual([{ forget: true }, { forget: false }])
  })
})
