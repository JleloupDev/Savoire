// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// Toolbar — Markdown toolbar, mounted above the CodeMirror editor.

import { useEditorContext } from './EditorContext'
import type { MarkdownFormat } from '@savoire/editor-core'

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

// ── Button ────────────────────────────────────────────────────────────────────

interface BtnProps {
  title: string
  format: MarkdownFormat
  children: React.ReactNode
}

function Btn({ title, format, children }: BtnProps) {
  const ctrl = useEditorContext()

  function handleMouseDown(e: React.MouseEvent) {
    // Prevent the editor from losing focus
    e.preventDefault()
    ctrl?.toggleFormat(format)
  }

  return (
    <button
      title={title}
      onMouseDown={handleMouseDown}
      style={btnStyle()}
      onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.background = 'var(--bg-elevated, #273147)'; (e.currentTarget as HTMLButtonElement).style.color = 'var(--text, #e6ebf4)' }}
      onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.background = 'transparent'; (e.currentTarget as HTMLButtonElement).style.color = 'var(--text-muted, #b2bfd6)' }}
    >
      {children}
    </button>
  )
}

function Sep() {
  return <span style={sepStyle} />
}

// ── Toolbar ───────────────────────────────────────────────────────────────────

export function Toolbar() {
  return (
    <div style={barStyle}>
      {/* Headings */}
      <Btn title="Titre 1 (# )" format="h1">H1</Btn>
      <Btn title="Titre 2 (## )" format="h2">H2</Btn>
      <Btn title="Titre 3 (### )" format="h3">H3</Btn>

      <Sep />

      {/* Inline */}
      <Btn title="Gras (**texte**)" format="bold"><b>B</b></Btn>
      <Btn title="Italique (*texte*)" format="italic"><i>I</i></Btn>
      <Btn title="Barré (~~texte~~)" format="strike"><s>S</s></Btn>
      <Btn title="Code inline (`texte`)" format="code">
        <span style={{ fontFamily: 'monospace', fontSize: '0.85em' }}>`c`</span>
      </Btn>

      <Sep />

      {/* Lists */}
      <Btn title="Liste à puces (- )" format="ul">
        <ListBulletIcon />
      </Btn>
      <Btn title="Liste numérotée (1. )" format="ol">
        <ListOrderedIcon />
      </Btn>
      <Btn title="Citation (> )" format="blockquote">
        <QuoteIcon />
      </Btn>

      <Sep />

      {/* Misc */}
      <Btn title="Lien [texte](url)" format="link">
        <LinkIcon />
      </Btn>
      <Btn title="Séparateur (---)" format="hr">—</Btn>
    </div>
  )
}

// ── Micro SVG icons ───────────────────────────────────────────────────────────

function ListBulletIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
      <circle cx="2" cy="4" r="1.5"/>
      <rect x="5" y="3" width="10" height="2" rx="1"/>
      <circle cx="2" cy="8" r="1.5"/>
      <rect x="5" y="7" width="10" height="2" rx="1"/>
      <circle cx="2" cy="12" r="1.5"/>
      <rect x="5" y="11" width="10" height="2" rx="1"/>
    </svg>
  )
}

function ListOrderedIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
      <text x="0" y="5" fontSize="5" fontFamily="monospace">1.</text>
      <rect x="5" y="3" width="10" height="2" rx="1"/>
      <text x="0" y="9" fontSize="5" fontFamily="monospace">2.</text>
      <rect x="5" y="7" width="10" height="2" rx="1"/>
      <text x="0" y="13" fontSize="5" fontFamily="monospace">3.</text>
      <rect x="5" y="11" width="10" height="2" rx="1"/>
    </svg>
  )
}

function QuoteIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
      <rect x="0" y="2" width="2" height="12" rx="1"/>
      <rect x="4" y="4" width="11" height="2" rx="1"/>
      <rect x="4" y="8" width="9" height="2" rx="1"/>
      <rect x="4" y="12" width="7" height="2" rx="1"/>
    </svg>
  )
}

function LinkIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M6.5 9.5a3.5 3.5 0 0 0 4.95 0l2-2a3.5 3.5 0 0 0-4.95-4.95l-1 1"/>
      <path d="M9.5 6.5a3.5 3.5 0 0 0-4.95 0l-2 2a3.5 3.5 0 0 0 4.95 4.95l1-1"/>
    </svg>
  )
}
