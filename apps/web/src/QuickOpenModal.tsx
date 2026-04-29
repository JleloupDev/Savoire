// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import { useState, useEffect, useRef } from 'react'
import { t } from '@savoire/i18n'

const SearchIco = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
  </svg>
)

const FileIco = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><polyline points="13 2 13 9 20 9"/>
  </svg>
)

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
  const [selected, setSelected] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => { inputRef.current?.focus() }, [])

  const filtered = query.trim()
    ? documents.filter(d =>
        d.path.toLowerCase().includes(query.toLowerCase()) ||
        (d.title ?? '').toLowerCase().includes(query.toLowerCase()),
      ).slice(0, 20)
    : documents.slice(0, 20)

  useEffect(() => { setSelected(0) }, [query])

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Escape') { e.preventDefault(); onClose() }
    if (e.key === 'ArrowDown') { e.preventDefault(); setSelected(s => Math.min(s + 1, filtered.length - 1)) }
    if (e.key === 'ArrowUp') { e.preventDefault(); setSelected(s => Math.max(s - 1, 0)) }
    if (e.key === 'Enter') { e.preventDefault(); if (filtered[selected]) { onSelect(filtered[selected].path); onClose() } }
  }

  return (
    <div
      style={{ position: 'fixed', inset: 0, zIndex: 9999, background: 'var(--overlay)', display: 'flex', alignItems: 'flex-start', justifyContent: 'center', paddingTop: '14vh' }}
      onClick={onClose}
    >
      <div
        style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 10, boxShadow: 'var(--shadow-lg)', width: 500, maxWidth: '90vw', overflow: 'hidden' }}
        onClick={e => e.stopPropagation()}
      >
        {/* Search row */}
        <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ color: 'var(--text-faint)', display: 'flex', flexShrink: 0 }}><SearchIco /></span>
          <input
            ref={inputRef}
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={t('app', 'quickopen.placeholder')}
            style={{ flex: 1, border: 'none', background: 'transparent', fontSize: 14, color: 'var(--text)', outline: 'none' }}
          />
          <span style={{ fontSize: 11, color: 'var(--text-faint)', background: 'var(--bg-elevated)', padding: '2px 6px', borderRadius: 4, flexShrink: 0 }}>Esc</span>
        </div>

        {/* Results */}
        <div style={{ maxHeight: 300, overflowY: 'auto' }}>
          {filtered.length === 0 ? (
            <div style={{ padding: '14px 16px', color: 'var(--text-faint)', fontSize: 13 }}>{t('app', 'quickopen.empty')}</div>
          ) : (
            filtered.map((doc, i) => {
              const parts = doc.path.split('/')
              const name = parts.pop() ?? doc.path
              const dir = parts.length > 0 ? parts.join('/') + '/' : ''
              return (
                <div
                  key={doc.id}
                  onClick={() => { onSelect(doc.path); onClose() }}
                  onMouseEnter={() => setSelected(i)}
                  style={{ padding: '9px 16px', cursor: 'pointer', background: i === selected ? 'var(--bg-elevated)' : 'transparent', display: 'flex', alignItems: 'center', gap: 10 }}
                >
                  <span style={{ color: 'var(--accent)', display: 'flex', flexShrink: 0 }}><FileIco /></span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: i === selected ? 500 : 400, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {name.replace(/\.md$/, '')}
                    </div>
                    {dir && <div style={{ fontSize: 11, color: 'var(--text-faint)' }}>{dir}</div>}
                  </div>
                </div>
              )
            })
          )}
        </div>

        {/* Footer shortcuts */}
        <div style={{ padding: '8px 16px', borderTop: '1px solid var(--border)', display: 'flex', gap: 12 }}>
          {([['↑↓', t('app', 'quickopen.hint.navigate')], ['↵', t('app', 'quickopen.hint.open')], ['Esc', t('app', 'quickopen.hint.close')]] as [string, string][]).map(([k, v]) => (
            <span key={k} style={{ fontSize: 11, color: 'var(--text-faint)' }}>
              <span style={{ background: 'var(--bg-elevated)', padding: '1px 5px', borderRadius: 3, marginRight: 4 }}>{k}</span>{v}
            </span>
          ))}
        </div>
      </div>
    </div>
  )
}
