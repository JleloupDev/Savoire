// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// WIP — full-text search panel, functional but not production-ready.
import { useState, useCallback, useRef } from 'react'
import type { ViewContext, Widget } from '@savoire/plugin-api'
import type { FullTextIndexContributor, FullTextSearchResult } from './FullTextIndexContributor'

const T = {
  panel:    { height: '100%', display: 'flex', flexDirection: 'column' as const, fontFamily: 'inherit', color: 'inherit', fontSize: 13 },
  header:   { padding: '8px 10px 6px', borderBottom: '1px solid rgba(255,255,255,0.07)', flexShrink: 0 },
  title:    { fontWeight: 600, fontSize: '0.7rem', textTransform: 'uppercase' as const, letterSpacing: '0.08em', color: 'var(--text-faint, #888)', marginBottom: 6 },
  input:    { width: '100%', boxSizing: 'border-box' as const, background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 5, padding: '5px 8px', color: 'inherit', fontSize: 13, outline: 'none' },
  body:     { flex: 1, overflow: 'auto', padding: '4px 0' },
  empty:    { padding: '10px 12px', fontSize: '0.75rem', color: 'var(--text-faint, #888)', fontStyle: 'italic' as const },
  result:   { padding: '6px 12px', cursor: 'pointer', borderBottom: '1px solid rgba(255,255,255,0.04)', display: 'block' as const } as React.CSSProperties,
  filename: { fontSize: '0.78rem', color: 'var(--text, #cdd6f4)', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const },
  path:     { fontSize: '0.65rem', color: 'var(--text-faint, #888)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const, marginTop: 1 },
  count:    { fontSize: '0.65rem', color: 'var(--text-faint, #888)', padding: '4px 12px' },
}

function SearchPanel({ ctx, getContributor }: { ctx: ViewContext; getContributor: () => FullTextIndexContributor }) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<FullTextSearchResult[]>([])
  const [hovered, setHovered] = useState<string | null>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const { workspace } = ctx

  const runSearch = useCallback((q: string) => {
    setQuery(q)
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => {
      setResults(q.trim() ? getContributor().search(q) : [])
    }, 100)
  }, [getContributor])

  const openResult = useCallback((path: string) => {
    if (path) void workspace.openFile(path)
  }, [workspace])

  return (
    <div style={T.panel}>
      <div style={T.header}>
        <div style={T.title}>Recherche <span style={{ color: 'var(--color-orange, #fab387)', fontStyle: 'italic', fontWeight: 400 }}>[WIP]</span></div>
        <input
          autoFocus
          style={T.input}
          placeholder="Rechercher dans le vault…"
          value={query}
          onChange={e => runSearch(e.target.value)}
          spellCheck={false}
        />
      </div>

      <div style={T.body}>
        {!query && (
          <div style={T.empty}>Tapez pour rechercher dans tous les documents.</div>
        )}
        {query && results.length === 0 && (
          <div style={T.empty}>Aucun résultat pour « {query} ».</div>
        )}
        {results.length > 0 && (
          <>
            <div style={T.count}>{results.length} résultat{results.length > 1 ? 's' : ''}</div>
            {results.map(r => {
              const filename = r.path.split('/').at(-1) ?? r.path
              return (
                <div
                  key={r.docId}
                  style={{
                    ...T.result,
                    background: hovered === r.docId ? 'rgba(255,255,255,0.05)' : 'transparent',
                  }}
                  onMouseEnter={() => setHovered(r.docId)}
                  onMouseLeave={() => setHovered(null)}
                  onClick={() => openResult(r.path)}
                >
                  <div style={T.filename}>{filename}</div>
                  {r.path !== filename && <div style={T.path}>{r.path}</div>}
                </div>
              )
            })}
          </>
        )}
      </div>
    </div>
  )
}

export class SearchWidget implements Widget {
  constructor(
    private readonly ctx: ViewContext,
    private readonly getContributor: () => FullTextIndexContributor,
  ) {}

  render() {
    return <SearchPanel ctx={this.ctx} getContributor={this.getContributor} />
  }

  dispose(): void {}
}
