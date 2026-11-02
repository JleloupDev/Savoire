// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// Hashtags de la note active, et notes d'un tag. Avec un index de tout le
// vault (api.indexer, pouvoir tags : pair indexeur ou index local complet),
// les notes d'un tag comprennent celles jamais ouvertes ici, et les tags du
// vault sont listes ; sinon, l'index partage des hashtags. Voir ADR-027.
import { useState, useEffect, useCallback, useRef } from 'react'
import type { IIndexerAPI, TagCount, ViewContext, Widget } from '@savoire/plugin-api'
import type { HashtagIndexContributor } from './HashtagIndexContributor'

/** Tags du vault affiches au plus (les plus utilises). */
const VAULT_TAGS_LIMIT = 60

function HashtagsPanel({
  ctx,
  getContributor,
  indexer,
}: {
  ctx: ViewContext
  getContributor: () => HashtagIndexContributor
  indexer?: IIndexerAPI
}) {
  const { workspace } = ctx

  const [currentPath, setCurrentPath] = useState<string | null>(
    () => workspace.getActiveDocument()?.path ?? null
  )
  const [tags, setTags] = useState<string[]>([])
  const [selectedTag, setSelectedTag] = useState<string | null>(null)
  const [docsForTag, setDocsForTag] = useState<Array<{ docId: string; path: string }>>([])
  const [vaultTags, setVaultTags] = useState<TagCount[] | null>(null)
  const request = useRef(0)

  const refresh = useCallback((path: string | null) => {
    if (!path) { setTags([]); return }
    // Le contributeur range les tags par id de document.
    setTags(getContributor().getHashtagsForDoc(ctx.vault.resolveDocumentId(path) ?? path))
    setSelectedTag(null)
    setDocsForTag([])
  }, [getContributor, ctx])

  // Tags de tout le vault, quand un index complet repond.
  const loadVaultTags = useCallback(() => {
    if (!indexer?.available()) { setVaultTags(null); return }
    indexer.tags.list({ limit: VAULT_TAGS_LIMIT }).then(r => setVaultTags(r.items), () => setVaultTags(null))
  }, [indexer])

  useEffect(() => {
    loadVaultTags()
    const unsubState = indexer?.onStateChange(() => loadVaultTags())
    const unsubVault = ctx.workspace.subscribeVaultChange?.(() => loadVaultTags())
    return () => { unsubState?.(); unsubVault?.() }
  }, [indexer, ctx, loadVaultTags])

  useEffect(() => { refresh(currentPath) }, [currentPath, refresh])

  useEffect(() => {
    const unsub = workspace.subscribeActiveDocument?.((path) => {
      setCurrentPath(path)
    })
    return unsub
  }, [workspace])

  const selectTag = (tag: string) => {
    const n = ++request.current
    setSelectedTag(tag)
    const local = () => { if (n === request.current) setDocsForTag(getContributor().getDocsForHashtag(tag)) }
    if (!indexer?.available()) { local(); return }
    // Index complet : toutes les notes du tag (sous-tags compris), ouvertes ou non.
    indexer.tags.notes({ tag }).then(r => {
      if (n === request.current) setDocsForTag(r.items.map(i => ({ docId: i.id, path: i.path })))
    }, local)
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
        {vaultTags && vaultTags.length > 0 && (
          <>
            <div style={T.section} title="Tous les tags du vault, notes jamais ouvertes comprises">Tags du vault</div>
            <div style={T.tagRow} data-testid="vault-tags">
              {vaultTags.map(t => (
                <span key={t.tag} style={T.tag(selectedTag === t.tag)} onClick={() => selectTag(t.tag)} title={`${t.count} note${t.count > 1 ? 's' : ''}`}>
                  #{t.tag} <span style={{ opacity: 0.6 }}>{t.count}</span>
                </span>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  )
}

export class HashtagsWidget implements Widget {
  constructor(
    private readonly ctx: ViewContext,
    private readonly getContributor: () => HashtagIndexContributor,
    private readonly indexer?: IIndexerAPI,
  ) {}

  render() {
    return <HashtagsPanel ctx={this.ctx} getContributor={this.getContributor} indexer={this.indexer} />
  }

  dispose(): void {}
}
