// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// Toolbar — Markdown toolbar, mounted above the CodeMirror editor.

import { useState } from 'react'
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
  const [open, setOpen] = useState(false)

  function exec(target: ToolbarCommand) {
    const core = ctrl as unknown as { view?: unknown } | null
    target.run({ view: core?.view } as never)
  }

  function handleMouseDown(e: React.MouseEvent) {
    // Empeche l'editeur de perdre le focus.
    e.preventDefault()
    if (cmd.items?.length) { setOpen(o => !o); return }
    exec(cmd)
  }

  if (cmd.items?.length) {
    return (
      <span style={{ position: 'relative', display: 'inline-flex' }}>
        <button
          title={cmd.label}
          data-testid="toolbar-command"
          data-command-id={cmd.id}
          onMouseDown={handleMouseDown}
          style={btnStyle(open)}
        >
          {cmd.icon}
        </button>
        {open && (
          <span
            style={{
              position: 'absolute', top: '100%', left: 0, zIndex: 40, minWidth: 150,
              display: 'flex', flexDirection: 'column', padding: 4, gap: 1,
              background: 'var(--bg-elevated, #273147)',
              border: '1px solid var(--border, #2f3745)',
              borderRadius: 6, boxShadow: 'var(--shadow, 0 6px 20px rgba(0,0,0,0.35))',
            }}
            onMouseDown={e => e.preventDefault()}
          >
            {cmd.items.map(sub => (
              <button
                key={sub.id}
                data-testid="toolbar-command"
                data-command-id={sub.id}
                title={sub.label}
                onMouseDown={() => { exec(sub); setOpen(false) }}
                style={{ ...btnStyle(), justifyContent: 'flex-start', gap: 8, width: '100%', height: 24 }}
              >
                <span style={{ minWidth: 22, opacity: 0.75 }}>{sub.icon}</span>
                <span style={{ fontWeight: 500 }}>{sub.label}</span>
              </button>
            ))}
          </span>
        )}
      </span>
    )
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
