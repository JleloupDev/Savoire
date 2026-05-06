// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import { useState, useEffect, useCallback } from 'react'
import type { ViewContext, Widget } from '@savoire/plugin-api'
import type { WikilinkIndexContributor, BacklinkEntry } from './WikilinkIndexContributor'

function BacklinksPanel({
  ctx,
  contributor,
}: {
  ctx: ViewContext
  contributor: WikilinkIndexContributor
}) {
  const { workspace } = ctx

  const [currentPath, setCurrentPath] = useState<string | null>(
    () => workspace.getActiveDocument()?.path ?? null
  )
  const [backlinks, setBacklinks] = useState<BacklinkEntry[]>([])

  const refresh = useCallback((path: string | null) => {
    if (!path) { setBacklinks([]); return }
    setBacklinks(contributor.getBacklinks(path))
  }, [contributor])

  useEffect(() => { refresh(currentPath) }, [currentPath, refresh])

  useEffect(() => {
    const unsub = workspace.subscribeActiveDocument?.((path) => { setCurrentPath(path) })
    return unsub
  }, [workspace])

  const T = {
    panel:   { height: '100%', display: 'flex', flexDirection: 'column' as const, fontFamily: 'inherit', color: 'inherit', fontSize: 13 },
    header:  { padding: '8px 10px 4px', borderBottom: '1px solid rgba(255,255,255,0.07)', flexShrink: 0 },
    title:   { fontWeight: 600, fontSize: '0.7rem', textTransform: 'uppercase' as const, letterSpacing: '0.08em', color: 'var(--text-faint, #888)', marginBottom: 4 },
    docName: { fontSize: '0.78rem', color: 'var(--text, #cdd6f4)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const },
    body:    { flex: 1, overflow: 'auto', padding: '4px 0' },
    empty:   { padding: '12px 10px', fontSize: '0.75rem', color: 'var(--text-faint, #888)', fontStyle: 'italic' as const },
    item:    { padding: '5px 10px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6, borderRadius: 4, margin: '0 4px' } as React.CSSProperties,
    badge:   { fontSize: '0.6rem', padding: '1px 5px', borderRadius: 4, background: 'rgba(255,255,255,0.07)', color: 'var(--text-faint, #888)', flexShrink: 0 } as React.CSSProperties,
  }

  return (
    <div style={T.panel}>
      <div style={T.header}>
        <div style={T.title}>Backlinks</div>
        {currentPath
          ? <div style={T.docName}>{currentPath.split('/').at(-1)}</div>
          : <div style={T.docName}>—</div>
        }
      </div>
      <div style={T.body}>
        {!currentPath && <div style={T.empty}>Ouvrir un document pour voir ses backlinks.</div>}
        {currentPath && backlinks.length === 0 && <div style={T.empty}>Aucun document ne pointe vers celui-ci.</div>}
        {backlinks.map(bl => (
          <div
            key={bl.docId}
            style={T.item}
            onClick={() => void workspace.openFile(bl.path)}
            onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = 'rgba(255,255,255,0.06)' }}
            onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'transparent' }}
          >
            <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {bl.path.split('/').at(-1)}
            </span>
            <span style={T.badge}>wikilink</span>
          </div>
        ))}
      </div>
    </div>
  )
}

export class BacklinksWidget implements Widget {
  constructor(
    private readonly ctx: ViewContext,
    private readonly contributor: WikilinkIndexContributor,
  ) {}

  render() {
    return <BacklinksPanel ctx={this.ctx} contributor={this.contributor} />
  }

  dispose(): void {}
}
