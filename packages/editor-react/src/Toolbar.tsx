// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// Toolbar — Markdown toolbar, mounted above the CodeMirror editor.

import { useEditorContext } from './EditorContext'
import type { ToolbarCommand } from '@savoire/plugin-api'

// ── Styles ────────────────────────────────────────────────────────────────────

const barStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  flexWrap: 'wrap',
  gap: 2,
  padding: '4px 8px',
  borderBottom: '1px solid var(--border, #2f3745)',
  background: 'var(--bg-surface, #1b2130)',
  flexShrink: 0,
  userSelect: 'none',
  color: 'var(--text, #e6ebf4)',
  boxSizing: 'border-box',
}

const sepStyle: React.CSSProperties = {
  width: 1,
  height: 18,
  background: 'var(--border, #2f3745)',
  margin: '0 4px',
  flexShrink: 0,
}

function btnStyle(active = false): React.CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    minWidth: 26,
    height: 26,
    padding: '0 5px',
    border: 'none',
    borderRadius: 4,
    background: active ? 'var(--accent-dim, rgba(70,120,240,0.2))' : 'transparent',
    color: active ? 'var(--accent, #7ea2ff)' : 'var(--text-muted, #b2bfd6)',
    fontSize: '0.78rem',
    fontWeight: 600,
    cursor: 'pointer',
    lineHeight: 1,
    transition: 'background 0.1s, color 0.1s',
  }
}

// ── Bouton ────────────────────────────────────────────────────────────────────

function Btn({ cmd }: { cmd: ToolbarCommand }) {
  const ctrl = useEditorContext()

  function handleMouseDown(e: React.MouseEvent) {
    // Empeche l'editeur de perdre le focus.
    e.preventDefault()
    const core = ctrl as unknown as { view?: unknown } | null
    cmd.run({ view: core?.view } as never)
  }

  return (
    <button
      title={cmd.label}
      data-testid="toolbar-command"
      data-command-id={cmd.id}
      onMouseDown={handleMouseDown}
      style={btnStyle()}
      onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.background = 'var(--bg-elevated, #273147)'; (e.currentTarget as HTMLButtonElement).style.color = 'var(--text, #e6ebf4)' }}
      onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.background = 'transparent'; (e.currentTarget as HTMLButtonElement).style.color = 'var(--text-muted, #b2bfd6)' }}
    >
      {cmd.icon}
    </button>
  )
}

function Sep() {
  return <span style={sepStyle} />
}

// ── Barre ─────────────────────────────────────────────────────────────────────
//
// Rendue depuis le REGISTRE de commandes, plus en dur. Un plugin qui appelle
// api.toolbar.register() voit son bouton apparaitre ici, dans son groupe.
// Auparavant le registre existait, EditorCore y enregistrait sept commandes,
// et ce composant les ignorait au profit d'une liste figee : le point
// d'extension n'etait branche nulle part.

/** Ordre d'affichage des groupes. Les groupes inconnus (plugins) suivent. */
const GROUP_ORDER = ['bloc', 'format', 'liste', 'insert']

export function Toolbar() {
  const ctrl = useEditorContext()
  const commands = ctrl?.getToolbarCommands?.() ?? []
  if (commands.length === 0) return <div style={barStyle} />

  const groups = new Map<string, ToolbarCommand[]>()
  for (const cmd of commands) {
    const g = cmd.group ?? 'autre'
    if (!groups.has(g)) groups.set(g, [])
    groups.get(g)!.push(cmd)
  }
  const ordered = [
    ...GROUP_ORDER.filter(g => groups.has(g)),
    ...[...groups.keys()].filter(g => !GROUP_ORDER.includes(g)),
  ]

  return (
    <div style={barStyle} data-testid="editor-toolbar">
      {ordered.map((g, i) => (
        <span key={g} style={{ display: 'contents' }}>
          {i > 0 && <Sep />}
          {groups.get(g)!.map(cmd => <Btn key={cmd.id} cmd={cmd} />)}
        </span>
      ))}
    </div>
  )
}
