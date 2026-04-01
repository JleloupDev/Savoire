// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// MetadataWidget — affiche les métadonnées indexées du document courant.
//

import { useState, useEffect, useCallback, useRef } from 'react'
import type { ViewContext, VaultAPI, Widget } from '@savoire/plugin-api'

interface DocumentMetaDto {
  documentId: string
  contentType: string | null
  derivedFrom: string | null
  derivedBy: string | null
  tags: string[]
  frontmatterJson: string   // JSON string, e.g. '{"title":"Test"}'
  indexedAt: string
}

async function fetchMeta(
  vaultId: string,
  docId: string,
  token: string,
): Promise<DocumentMetaDto | null> {
  try {
    const res = await fetch(`/api/v1/vaults/${vaultId}/documents/${docId}/meta`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    })
    if (!res.ok) return null
    return res.json() as Promise<DocumentMetaDto>
  } catch {
    return null
  }
}

// ── Component ─────────────────────────────────────────────────────────────────

function MetadataPanel({
  ctx,
  vault,
}: {
  ctx: ViewContext
  vault: VaultAPI
}) {
  const { workspace } = ctx

  const [currentPath, setCurrentPath] = useState<string | null>(
    () => workspace.getActiveDocument()?.path ?? null,
  )
  const [meta, setMeta] = useState<DocumentMetaDto | null>(null)
  const [loading, setLoading] = useState(false)
  const abortRef = useRef<AbortController | null>(null)

  const load = useCallback(async (path: string | null) => {
    abortRef.current?.abort()
    if (!path) { setMeta(null); return }

    const vaultId = vault.getVaultId?.() ?? ''
    const docId = vault.resolveDocumentId(path) ?? ''
    const token = vault.getToken?.() ?? ''
    if (!vaultId || !docId) { setMeta(null); return }

    setLoading(true)
    const ac = new AbortController()
    abortRef.current = ac
    const result = await fetchMeta(vaultId, docId, token)
    if (!ac.signal.aborted) {
      setMeta(result)
      setLoading(false)
    }
  }, [vault])

  // Refresh when path changes
  useEffect(() => {
    void load(currentPath)
  }, [currentPath, load])

  // Subscribe to active-document changes (tab switch + file open)
  useEffect(() => {
    const unsub = workspace.subscribeActiveDocument?.((path) => {
      setCurrentPath(path)
    })
    return unsub
  }, [workspace, setCurrentPath])

  // Re-fetch when the current document is re-indexed (frontmatter/tags changed).
  // see ADR-016
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null
    const unsub = workspace.subscribeDocumentIndexed?.((_, path) => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        setCurrentPath(prev => {
          if (prev === path) void load(path)
          return prev
        })
      }, 300)
    })
    return () => {
      if (timer) clearTimeout(timer)
      unsub?.()
    }
  }, [workspace, load, setCurrentPath])

  // ── Styles ──────────────────────────────────────────────────────────────────

  const T = {
    panel:   { height: '100%', display: 'flex', flexDirection: 'column' as const, fontFamily: 'inherit', color: 'inherit', fontSize: 13 },
    header:  { padding: '8px 10px 4px', borderBottom: '1px solid rgba(255,255,255,0.07)', flexShrink: 0 },
    title:   { fontWeight: 600, fontSize: '0.7rem', textTransform: 'uppercase' as const, letterSpacing: '0.08em', color: 'var(--text-faint, #888)', marginBottom: 4 },
    docName: { fontSize: '0.78rem', color: 'var(--text, #cdd6f4)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const },
    body:    { flex: 1, overflow: 'auto', padding: '6px 10px' },
    empty:   { padding: '8px 0', fontSize: '0.75rem', color: 'var(--text-faint, #888)', fontStyle: 'italic' as const },
    section: { marginBottom: 12 } as React.CSSProperties,
    sectionTitle: { fontSize: '0.65rem', fontWeight: 700, textTransform: 'uppercase' as const, letterSpacing: '0.1em', color: 'var(--text-faint, #888)', marginBottom: 4 },
    tag:     { display: 'inline-block', padding: '1px 7px', borderRadius: 4, background: 'rgba(139,92,246,0.18)', color: 'var(--accent, #8b5cf6)', fontSize: '0.7rem', marginRight: 4, marginBottom: 4 } as React.CSSProperties,
    row:     { display: 'flex', gap: 6, marginBottom: 3, fontSize: '0.75rem' } as React.CSSProperties,
    key:     { color: 'var(--text-faint, #888)', flexShrink: 0, minWidth: 80 } as React.CSSProperties,
    val:     { color: 'var(--text, #cdd6f4)', wordBreak: 'break-all' as const, flex: 1 } as React.CSSProperties,
    pill:    { fontSize: '0.65rem', padding: '1px 5px', borderRadius: 3, background: 'rgba(255,255,255,0.07)', color: 'var(--text-faint, #888)' } as React.CSSProperties,
  }

  const fmEntries: [string, unknown][] = (() => {
    try {
      const parsed = meta?.frontmatterJson ? JSON.parse(meta.frontmatterJson) as Record<string, unknown> : null
      return parsed ? Object.entries(parsed) : []
    } catch { return [] }
  })()

  return (
    <div style={T.panel}>
      <div style={T.header}>
        <div style={T.title}>Métadonnées</div>
        {currentPath
          ? <div style={T.docName}>{currentPath.split('/').at(-1)}</div>
          : <div style={T.docName}>—</div>
        }
      </div>

      <div style={T.body}>
        {!currentPath && (
          <div style={T.empty}>Ouvrir un document pour voir ses métadonnées.</div>
        )}
        {currentPath && loading && (
          <div style={T.empty}>Chargement…</div>
        )}
        {currentPath && !loading && !meta && (
          <div style={T.empty}>Pas de métadonnées indexées pour ce document.</div>
        )}
        {meta && (
          <>
            {/* Tags */}
            {meta.tags.length > 0 && (
              <div style={T.section}>
                <div style={T.sectionTitle}>Tags</div>
                <div>{meta.tags.map(t => <span key={t} style={T.tag}>#{t}</span>)}</div>
              </div>
            )}

            {/* Frontmatter */}
            {fmEntries.length > 0 && (
              <div style={T.section}>
                <div style={T.sectionTitle}>Frontmatter</div>
                {fmEntries.map(([k, v]) => (
                  <div key={k} style={T.row}>
                    <span style={T.key}>{k}</span>
                    <span style={T.val}>{Array.isArray(v) ? v.join(', ') : String(v ?? '')}</span>
                  </div>
                ))}
              </div>
            )}

            {/* Technical */}
            <div style={T.section}>
              <div style={T.sectionTitle}>Technique</div>
              {meta.contentType && (
                <div style={T.row}>
                  <span style={T.key}>type</span>
                  <span style={{ ...T.pill, ...T.val }}>{meta.contentType}</span>
                </div>
              )}
              {meta.derivedFrom && (
                <div style={T.row}>
                  <span style={T.key}>derivedFrom</span>
                  <span style={T.val}>{meta.derivedFrom}</span>
                </div>
              )}
              {meta.derivedBy && (
                <div style={T.row}>
                  <span style={T.key}>derivedBy</span>
                  <span style={T.val}>{meta.derivedBy}</span>
                </div>
              )}
              <div style={T.row}>
                <span style={T.key}>indexedAt</span>
                <span style={T.val}>{new Date(meta.indexedAt).toLocaleString()}</span>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

// ── Widget wrapper ─────────────────────────────────────────────────────────────

export class MetadataWidget implements Widget {
  constructor(
    private readonly ctx: ViewContext,
    private readonly vault: VaultAPI,
  ) {}

  render() {
    return <MetadataPanel ctx={this.ctx} vault={this.vault} />
  }

  dispose(): void {}
}
