// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Parametres → Agents → MCP local (bureau seulement, ADR-033) : un client MCP
// du poste (Claude Desktop, Claude Code) se branche sur l'appli ouverte. On
// choisit l'agent qui le porte : ses droits, et lui seul. Le jeton ne sort pas
// du poste.
import { useEffect, useState } from 'react'
import type { AgentDefinition } from '@savoire/plugin-api'
import {
  mcpLocalCommands, onLocalMcpApprovals, pendingLocalMcpApprovals, readLocalMcpSettings, writeLocalMcpSettings,
  type LocalMcpSettings as Settings, type McpLocalStatus,
} from './localMcpDesktop'

const INPUT: React.CSSProperties = {
  width: '100%', boxSizing: 'border-box', padding: '5px 8px', borderRadius: 6,
  border: '1px solid var(--border)', background: 'var(--bg-elevated)', color: 'var(--text)', font: 'inherit', fontSize: 12,
}
const BTN: React.CSSProperties = {
  padding: '4px 10px', borderRadius: 6, border: '1px solid var(--border)', background: 'transparent',
  color: 'var(--text)', font: 'inherit', fontSize: 12, cursor: 'pointer',
}
const MUTED: React.CSSProperties = { color: 'var(--text-muted)', fontSize: 12 }
const CODE: React.CSSProperties = {
  margin: '4px 0 0', padding: 8, borderRadius: 6, background: 'var(--bg-elevated)', fontSize: 11,
  whiteSpace: 'pre-wrap', wordBreak: 'break-all', userSelect: 'all',
}

/** La config a coller dans claude_desktop_config.json : le pont stdio du programme de Savoire. */
export function claudeDesktopConfig(status: Pick<McpLocalStatus, 'exe'>): string {
  return JSON.stringify({ mcpServers: { savoire: { command: status.exe, args: ['--mcp-stdio'] } } }, null, 2)
}

/** La commande pour Claude Code (HTTP direct, avec le jeton). */
export function claudeCodeCommand(status: Pick<McpLocalStatus, 'url' | 'token'>): string {
  return `claude mcp add --transport http savoire ${status.url} --header "Authorization: Bearer ${status.token}"`
}

export function LocalMcpSettings({ agents }: { agents: AgentDefinition[] }) {
  const [settings, setSettings] = useState<Settings>(() => readLocalMcpSettings())
  const [status, setStatus] = useState<McpLocalStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [reveal, setReveal] = useState(false)

  useEffect(() => { mcpLocalCommands.status().then(setStatus, () => {}) }, [])

  const run = async (f: () => Promise<McpLocalStatus>) => {
    setError(null)
    try { setStatus(await f()) } catch (err) { setError(String(err instanceof Error ? err.message : err)) }
  }

  const save = (next: Settings) => { setSettings(next); writeLocalMcpSettings(next) }
  const toggle = (enabled: boolean) => {
    save({ ...settings, enabled })
    void run(enabled ? () => mcpLocalCommands.start() : () => mcpLocalCommands.stop())
  }
  const renew = () => {
    if (window.confirm('Générer un nouveau jeton ? Les clients branchés devront être reconfigurés.')) void run(() => mcpLocalCommands.newToken())
  }
  const chosen = agents.find(a => a.id === settings.agentId)

  return (
    <div data-testid="local-mcp" style={{ marginTop: 22, paddingTop: 14, borderTop: '1px solid var(--border)' }}>
      <div style={{ fontWeight: 600 }}>MCP local</div>
      <div style={MUTED}>
        Branche Claude Desktop ou Claude Code sur Savoire, tant que l’appli est ouverte. L’agent choisi porte ses droits :
        ce qu’il ne peut pas faire n’est pas proposé, et une action « demander » attend votre accord ici.
      </div>
      <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 12, marginTop: 8 }}>
        <input type="checkbox" data-testid="local-mcp-enabled" checked={settings.enabled} onChange={e => toggle(e.target.checked)} />
        Activer le MCP local (127.0.0.1 seulement, jeton exigé)
      </label>
      <label style={{ display: 'block', fontSize: 12, fontWeight: 600, margin: '10px 0 4px' }}>Agent</label>
      <select data-testid="local-mcp-agent" style={INPUT} value={settings.agentId} onChange={e => save({ ...settings, agentId: e.target.value })}>
        <option value="">Aucun (le MCP local ne fait rien)</option>
        {agents.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
        {settings.agentId && !chosen && <option value={settings.agentId}>Agent supprimé</option>}
      </select>
      {error && <div style={{ color: 'var(--danger, #ef4444)', fontSize: 12, marginTop: 6 }}>{error}</div>}
      {settings.enabled && status && (
        <div data-testid="local-mcp-config">
          <div style={{ ...MUTED, marginTop: 8 }}>{status.running ? `En écoute sur ${status.url}` : 'Arrêté.'}</div>
          <label style={{ display: 'block', fontSize: 12, fontWeight: 600, margin: '10px 0 4px' }}>Jeton</label>
          <div style={{ display: 'flex', gap: 6 }}>
            <input readOnly style={INPUT} type={reveal ? 'text' : 'password'} value={status.token} />
            <button style={BTN} onClick={() => setReveal(!reveal)}>{reveal ? 'Masquer' : 'Voir'}</button>
            <button data-testid="local-mcp-renew" style={BTN} onClick={renew}>Régénérer</button>
          </div>
          <label style={{ display: 'block', fontSize: 12, fontWeight: 600, margin: '10px 0 4px' }}>Claude Desktop</label>
          <div style={MUTED}>À coller dans claude_desktop_config.json, puis relancer Claude Desktop. Aucun jeton à y mettre.</div>
          <pre style={CODE}>{claudeDesktopConfig(status)}</pre>
          <label style={{ display: 'block', fontSize: 12, fontWeight: 600, margin: '10px 0 4px' }}>Claude Code</label>
          <pre style={CODE}>{reveal ? claudeCodeCommand(status) : claudeCodeCommand({ ...status, token: '<jeton>' })}</pre>
        </div>
      )}
    </div>
  )
}

/** Les accords demandes par le MCP local : une carte au-dessus de l'appli. */
export function LocalMcpApprovals() {
  const [, tick] = useState(0)
  useEffect(() => onLocalMcpApprovals(() => tick(n => n + 1)), [])
  const first = pendingLocalMcpApprovals()[0]
  if (!first) return null
  return (
    <div data-testid="local-mcp-approval" style={{
      position: 'fixed', right: 16, bottom: 16, zIndex: 2000, width: 340, padding: 12, borderRadius: 8,
      background: 'var(--bg-surface)', border: '1px solid var(--accent)', boxShadow: '0 8px 32px rgba(0,0,0,0.3)', fontSize: 12,
    }}>
      <div style={{ fontWeight: 600 }}>{first.req.actor.agentName} (via le MCP local) demande votre accord</div>
      <div style={{ marginTop: 4, wordBreak: 'break-word' }}>{first.req.summary}</div>
      <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
        <button data-testid="local-mcp-approve" style={{ ...BTN, background: 'var(--accent)', color: '#fff', border: '1px solid var(--accent)', fontWeight: 600 }} onClick={() => first.resolve('approved')}>Accepter</button>
        <button data-testid="local-mcp-refuse" style={BTN} onClick={() => first.resolve('refused')}>Refuser</button>
      </div>
    </div>
  )
}
