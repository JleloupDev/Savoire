// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// BubbleToolbar.tsx
// Floating toolbar that appears above text selections.
// Reads toolbar commands from ctrl.getToolbarCommands() — fully driven by the registry.

import { useState, useEffect, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { useEditorContext } from './EditorContext'
import type { ToolbarCommand } from '@savoire/plugin-api'

export function BubbleToolbar() {
  const ctrl = useEditorContext()
  const [coords, setCoords] = useState<{ x: number; y: number } | null>(null)
  const [cmds, setCmds] = useState<ToolbarCommand[]>([])

  const refresh = useCallback(() => {
    if (!ctrl) return
    const sel = ctrl.getSelectionCoords()
    const text = ctrl.getSelectionText()
    const hasText = text.length > 0
    setCoords(hasText ? sel : null)
    const allCmds = ctrl.getToolbarCommands()
    setCmds(allCmds.filter(c => !c.requiresSelection || hasText))
  }, [ctrl])

  useEffect(() => {
    if (!ctrl) return
    const unsub = ctrl.on('selectionChanged', refresh)
    return unsub
  }, [ctrl, refresh])

  if (!coords || !ctrl || cmds.length === 0) return null

  // see ADR-024
  return createPortal(
    <div
      style={{
        position: 'fixed',
        left: coords.x,
        top: coords.y - 44,
        transform: 'translateX(-50%)',
        zIndex: 800,
        background: 'var(--bg-elevated, #273147)',
        border: '1px solid var(--border, #2f3745)',
        borderRadius: 8,
        padding: '4px 6px',
        display: 'flex',
        gap: 2,
        boxShadow: '0 4px 16px rgba(0,0,0,0.25)',
        alignItems: 'center',
      }}
    >
      {cmds.map((cmd, i) => {
        const prevGroup = i > 0 ? cmds[i - 1].group : cmd.group
        const showSep = i > 0 && prevGroup !== cmd.group
        return (
          <span key={cmd.id} style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
            {showSep && <span style={{ width: 1, height: 16, background: 'var(--border, #2f3745)', margin: '0 3px' }} />}
            <button
              title={cmd.label}
              onMouseDown={e => { e.preventDefault(); ctrl.runToolbarCommand(cmd.id) }}
              style={{
                padding: '2px 8px',
                background: 'none',
                border: 'none',
                color: 'var(--text-muted, #b2bfd6)',
                cursor: 'pointer',
                borderRadius: 4,
                fontSize: '0.78rem',
                fontWeight: 700,
                minWidth: 28,
              }}
            >
              {cmd.icon}
            </button>
          </span>
        )
      })}
    </div>,
    document.body,
  )
}
