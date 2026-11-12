// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Palette de commandes (Ctrl+Maj+P) : toutes les commandes de l'application
// et des plugins, y compris celles des plugins du store, qui n'ont souvent
// pas de raccourci. Les commandes d'edition (qui agissent dans un editeur)
// n'y sont pas : elles s'utilisent depuis l'editeur.
import { useEffect, useRef, useState } from 'react'
import type { PluginCommand } from '@savoire/plugin-api'

const fold = (s: string): string => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()

export function CommandPaletteModal({ commands, format, onClose }: {
  commands: PluginCommand[]
  /** Texte du raccourci d'une commande (vide : aucun). */
  format: (command: PluginCommand) => string
  onClose: () => void
}) {
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  useEffect(() => { inputRef.current?.focus() }, [])
  useEffect(() => { setSelected(0) }, [query])

  const usable = commands
    .filter(c => !c.editor && c.label && (c.isAvailable?.({ editorView: null }) ?? true))
    .sort((a, b) => (a.label ?? '').localeCompare(b.label ?? ''))
  const words = fold(query).split(/\s+/).filter(Boolean)
  const filtered = usable.filter(c => words.every(w => fold(c.label ?? c.id).includes(w))).slice(0, 50)

  function run(c: PluginCommand) {
    onClose()
    try { c.run({ editorView: null }) } catch (err) { console.error(`[palette] ${c.id}`, err) }
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Escape') { e.preventDefault(); onClose() }
    if (e.key === 'ArrowDown') { e.preventDefault(); setSelected(s => Math.min(s + 1, filtered.length - 1)) }
    if (e.key === 'ArrowUp') { e.preventDefault(); setSelected(s => Math.max(s - 1, 0)) }
    if (e.key === 'Enter') { e.preventDefault(); if (filtered[selected]) run(filtered[selected]) }
  }

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 9999, background: 'var(--overlay)', display: 'flex', alignItems: 'flex-start', justifyContent: 'center', paddingTop: '14vh' }}>
      <div data-testid="command-palette" onClick={e => e.stopPropagation()}
        style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 10, boxShadow: 'var(--shadow-lg)', width: 520, maxWidth: '90vw', overflow: 'hidden' }}>
        <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)' }}>
          <input ref={inputRef} data-testid="command-palette-input" value={query} onChange={e => setQuery(e.target.value)} onKeyDown={onKeyDown}
            placeholder="Chercher une commande…"
            style={{ width: '100%', border: 'none', background: 'transparent', fontSize: 14, color: 'var(--text)', outline: 'none' }} />
        </div>
        <div style={{ maxHeight: 320, overflowY: 'auto' }}>
          {filtered.length === 0 && <div style={{ padding: '14px 16px', color: 'var(--text-faint)', fontSize: 13 }}>Aucune commande.</div>}
          {filtered.map((c, i) => (
            <div key={c.id} data-testid="command-palette-item" data-command-id={c.id}
              onClick={() => run(c)} onMouseEnter={() => setSelected(i)}
              style={{ padding: '9px 16px', cursor: 'pointer', background: i === selected ? 'var(--bg-elevated)' : 'transparent', display: 'flex', alignItems: 'center', gap: 10, fontSize: 13, color: 'var(--text)' }}>
              <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.label}</span>
              {format(c) && <span style={{ fontSize: 11, color: 'var(--text-faint)', background: 'var(--bg-elevated)', padding: '1px 6px', borderRadius: 4 }}>{format(c)}</span>}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
