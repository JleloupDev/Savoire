// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import { useState, useEffect, useCallback } from 'react'
import type { ViewContext, Widget } from '@savoire/plugin-api'
import type { HashtagIndexContributor } from './HashtagIndexContributor'

function HashtagsPanel({
  ctx,
  contributor,
}: {
  ctx: ViewContext
  contributor: HashtagIndexContributor
}) {
  const { workspace } = ctx

  const [currentPath, setCurrentPath] = useState<string | null>(
    () => workspace.getActiveDocument()?.path ?? null
  )
  const [tags, setTags] = useState<string[]>([])
  const [selectedTag, setSelectedTag] = useState<string | null>(null)
  const [docsForTag, setDocsForTag] = useState<Array<{ docId: string; path: string }>>([])

  const refresh = useCallback((path: string | null) => {
    if (!path) { setTags([]); return }
    // HashtagIndexContributor indexes by docId (which is set to path by ContentIndexingService)
    setTags(contributor.getHashtagsForDoc(path))
    setSelectedTag(null)
    setDocsForTag([])
  }, [contributor])

  useEffect(() => { refresh(currentPath) }, [currentPath, refresh])

  useEffect(() => {
    const unsub = workspace.subscribeActiveDocument?.((path) => {
      setCurrentPath(path)
    })
    return unsub
  }, [workspace])

  const selectTag = (tag: string) => {
    setSelectedTag(tag)
    setDocsForTag(contributor.getDocsForHashtag(tag))
  }

  const T = {
    panel:    { height: '100%', display: 'flex', flexDirection: 'column' as const, fontFamily: 'inherit', color: 'inherit', fontSize: 13 },
    header:   { padding: '8px 10px 4px', borderBottom: '1px solid rgba(255,255,255,0.07)', flexShrink: 0 },
    title:    { fontWeight: 600, fontSize: '0.7rem', textTransform: 'uppercase' as const, letterSpacing: '0.08em', color: 'var(--text-faint, #888)', marginBottom: 4 },
    docName:  { fontSize: '0.78rem', color: 'var(--text, #cdd6f4)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const },
    body:     { flex: 1, overflow: 'auto', padding: '4px 0' },
    empty:    { padding: '12px 10px', fontSize: '0.75rem', color: 'var(--text-faint, #888)', fontStyle: 'italic' as const },
    tagRow:   { display: 'flex', flexWrap: 'wrap' as const, gap: 4, padding: '8px 10px' },
    tag:      (active: boolean) => ({ padding: '2px 8px', borderRadius: 12, fontSize: '0.72rem', cursor: 'pointer', background: active ? 'var(--accent, #89b4fa)' : 'rgba(255,255,255,0.08)', color: active ? '#1e1e2e' : 'var(--text, #cdd6f4)' }) as React.CSSProperties,
    section:  { padding: '4px 10px 2px', fontSize: '0.65rem', textTransform: 'uppercase' as const, letterSpacing: '0.08em', color: 'var(--text-faint, #888)' },
    item:     { padding: '5px 10px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6, borderRadius: 4, margin: '0 4px' } as React.CSSProperties,
  }

  return (
    <div style={T.panel}>
      <div style={T.header}>
        <div style={T.title}>Hashtags</div>
        {currentPath
          ? <div style={T.docName}>{currentPath.split('/').at(-1)}</div>
          : <div style={T.docName}>—</div>
        }
      </div>
      <div style={T.body}>
        {!currentPath && <div style={T.empty}>Ouvrir un document pour voir ses hashtags.</div>}
        {currentPath && tags.length === 0 && <div style={T.empty}>Aucun hashtag dans ce document.</div>}
        {tags.length > 0 && (
          <div style={T.tagRow}>
            {tags.map(tag => (
              <span
                key={tag}
                style={T.tag(selectedTag === tag)}
                onClick={() => selectTag(tag)}
              >
                #{tag}
              </span>
            ))}
          </div>
        )}
        {selectedTag && (
          <>
            <div style={T.section}>Documents avec #{selectedTag}</div>
            {docsForTag.length === 0 && <div style={T.empty}>Aucun document.</div>}
            {docsForTag.map(doc => (
              <div
                key={doc.docId}
                style={T.item}
                onClick={() => void workspace.openFile(doc.path)}
                onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = 'rgba(255,255,255,0.06)' }}
                onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'transparent' }}
              >
                <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {doc.path.split('/').at(-1)}
                </span>
              </div>
            ))}
          </>
        )}
      </div>
    </div>
  )
}

export class HashtagsWidget implements Widget {
  constructor(
    private readonly ctx: ViewContext,
    private readonly contributor: HashtagIndexContributor,
  ) {}

  render() {
    return <HashtagsPanel ctx={this.ctx} contributor={this.contributor} />
  }

  dispose(): void {}
}
