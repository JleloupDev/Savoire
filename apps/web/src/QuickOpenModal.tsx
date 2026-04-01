// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import { useState, useEffect, useRef } from 'react'

export function QuickOpenModal({
  documents,
  onSelect,
  onClose,
}: {
  documents: { id: string; path: string; title: string | null }[]
  onSelect: (path: string) => void
  onClose: () => void
}) {
  const [query, setQuery] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => { inputRef.current?.focus() }, [])

  const filtered = query.trim()
    ? documents.filter(d =>
        d.path.toLowerCase().includes(query.toLowerCase()) ||
        (d.title ?? '').toLowerCase().includes(query.toLowerCase()),
      ).slice(0, 20)
    : documents.slice(0, 20)

  const [selected, setSelected] = useState(0)
  useEffect(() => { setSelected(0) }, [query])

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Escape') { e.preventDefault(); onClose() }
    if (e.key === 'ArrowDown') { e.preventDefault(); setSelected(s => Math.min(s + 1, filtered.length - 1)) }
    if (e.key === 'ArrowUp') { e.preventDefault(); setSelected(s => Math.max(s - 1, 0)) }
    if (e.key === 'Enter') { e.preventDefault(); if (filtered[selected]) { onSelect(filtered[selected].path); onClose() } }
  }

  return (
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 9999,
        background: 'rgba(0,0,0,0.4)',
        display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
        paddingTop: '15vh',
      }}
      onClick={onClose}
    >
      <div
        style={{
          background: 'var(--bg-surface)', border: '1px solid var(--border)',
          borderRadius: 8, boxShadow: 'var(--shadow)', width: '480px', maxWidth: '90vw',
          overflow: 'hidden',
        }}
        onClick={e => e.stopPropagation()}
      >
        <input
          ref={inputRef}
          value={query}
          onChange={e => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Ouvrir une note…"
          style={{
            width: '100%', padding: '12px 16px', background: 'transparent',
            border: 'none', borderBottom: '1px solid var(--border)',
            color: 'var(--text)', fontSize: '0.9rem', outline: 'none',
            boxSizing: 'border-box',
          }}
        />
        <div style={{ maxHeight: '320px', overflowY: 'auto' }}>
          {filtered.length === 0 ? (
            <div style={{ padding: '12px 16px', color: 'var(--text-faint)', fontSize: '0.82rem' }}>
              Aucun résultat
            </div>
          ) : (
            filtered.map((doc, i) => {
              const parts = doc.path.split('/')
              const name = parts.pop() ?? doc.path
              const dir = parts.join('/')
              return (
                <div
                  key={doc.id}
                  onClick={() => { onSelect(doc.path); onClose() }}
                  style={{
                    padding: '8px 16px', cursor: 'pointer',
                    background: i === selected ? 'var(--bg-elevated)' : 'transparent',
                    display: 'flex', flexDirection: 'column', gap: 1,
                  }}
                  onMouseEnter={() => setSelected(i)}
                >
                  <span style={{ fontSize: '0.85rem', color: 'var(--text)', fontWeight: i === selected ? 600 : 400 }}>
                    {name.replace(/\.md$/, '')}
                  </span>
                  {dir && <span style={{ fontSize: '0.72rem', color: 'var(--text-faint)' }}>{dir}</span>}
                </div>
              )
            })
          )}
        </div>
      </div>
    </div>
  )
}
