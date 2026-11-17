// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Le dock des bulles (voir bubbles.ts) : des pastilles rondes sur le bord
// droit, une par document mis en bulle. Un clic ouvre le document dans une
// petite fenetre flottante, au-dessus de l'espace de travail ; un second clic
// la referme. Une seule ouverte a la fois. Le document s'y edite comme dans
// un onglet (meme vue : DocumentPanelHost).
import { useEffect, useState, useSyncExternalStore } from 'react'
import { Icon } from '@savoire/ui-components'
import { DocumentPanelHost, type EditorAreaRefs } from './EditorAreaWidget'
import { bubbles } from './bubbles'
import type { DocumentDto } from './types'

const ICONS: Record<string, string> = {
  chat: 'messages-square', md: 'file-text', board: 'layout-dashboard', base: 'database', excalidraw: 'pen-tool',
  page: 'file-text', outline: 'list-tree', mp4: 'film', webm: 'film', mov: 'film', pdf: 'file',
}

const nameOf = (path: string) => (path.split('/').pop() ?? path).replace(/\.md$/i, '')
const extOf = (path: string) => path.split('.').pop()?.toLowerCase() ?? ''

export function BubbleDock({ refs, documents, vaultId, userId, onOpenInTab }: {
  refs: EditorAreaRefs | null
  documents: DocumentDto[]
  vaultId: string | undefined
  userId: string | undefined
  /** Ouvre le document dans un onglet (la bulle reste). */
  onOpenInTab(path: string): void
}) {
  useEffect(() => { bubbles.setScope(userId, vaultId) }, [userId, vaultId])
  const version = useSyncExternalStore(cb => bubbles.subscribe(cb), () => `${bubbles.list().map(b => b.docId).join(',')}|${bubbles.opened() ?? ''}`)
  const list = bubbles.list()
  const opened = bubbles.opened()
  // Le chemin a jour (renommage, deplacement) ; une bulle dont le document a disparu s'en va.
  const live = list.map(b => ({ ...b, doc: documents.find(d => d.id === b.docId) }))
  useEffect(() => {
    if (documents.length === 0) return
    for (const b of live) if (!b.doc) bubbles.remove(b.docId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [documents, version])
  const [hover, setHover] = useState<string | null>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') bubbles.close() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  if (!refs || !vaultId || !userId || live.length === 0) return null
  const current = live.find(b => b.docId === opened && b.doc)
  return (
    <>
      <div data-testid="bubble-dock" style={{ position: 'fixed', right: 18, bottom: 96, zIndex: 900, display: 'flex', flexDirection: 'column-reverse', gap: 10 }}>
        {live.filter(b => b.doc).map(b => {
          const path = b.doc!.path
          const active = b.docId === opened
          return (
            <div key={b.docId} style={{ position: 'relative' }} onMouseEnter={() => setHover(b.docId)} onMouseLeave={() => setHover(h => (h === b.docId ? null : h))}>
              <button
                data-testid="bubble"
                data-doc-id={b.docId}
                data-path={path}
                data-open={active ? 'true' : 'false'}
                title={nameOf(path)}
                onClick={() => bubbles.toggle(b.docId)}
                style={{
                  width: 48, height: 48, borderRadius: '50%', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
                  border: active ? '2px solid var(--accent)' : '1px solid var(--border)', background: 'var(--bg-surface)', color: active ? 'var(--accent)' : 'var(--text)',
                  boxShadow: '0 4px 14px rgba(0,0,0,0.18)',
                }}
              >
                <Icon name={ICONS[extOf(path)] ?? 'file-text'} size={20} />
              </button>
              {hover === b.docId && !active && (
                <div style={{ position: 'absolute', right: 56, top: 12, whiteSpace: 'nowrap', padding: '3px 8px', borderRadius: 6, fontSize: '0.75rem', background: 'var(--bg-elevated)', border: '1px solid var(--border)', color: 'var(--text)' }}>
                  {nameOf(path)}
                </div>
              )}
            </div>
          )
        })}
      </div>
      {current?.doc && (
        <div
          data-testid="bubble-window"
          data-doc-id={current.docId}
          style={{
            position: 'fixed', right: 78, bottom: 96, zIndex: 901, width: 400, height: 'min(560px, calc(100vh - 140px))',
            display: 'flex', flexDirection: 'column', borderRadius: 12, overflow: 'hidden',
            background: 'var(--bg-base, var(--bg))', border: '1px solid var(--border)', boxShadow: '0 12px 36px rgba(0,0,0,0.28)',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', borderBottom: '1px solid var(--border)', background: 'var(--bg-surface)' }}>
            <Icon name={ICONS[extOf(current.doc.path)] ?? 'file-text'} size={15} />
            <span style={{ flex: 1, minWidth: 0, fontWeight: 600, fontSize: '0.85rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{nameOf(current.doc.path)}</span>
            <button data-testid="bubble-open-tab" title="Ouvrir dans un onglet" onClick={() => { bubbles.close(); onOpenInTab(current.doc!.path) }} style={ICON_BTN}><Icon name="external-link" size={14} /></button>
            <button data-testid="bubble-remove" title="Retirer la bulle" onClick={() => bubbles.remove(current.docId)} style={ICON_BTN}><Icon name="trash-2" size={14} /></button>
            <button data-testid="bubble-close" title="Réduire" onClick={() => bubbles.close()} style={ICON_BTN}><Icon name="minus" size={14} /></button>
          </div>
          <div style={{ flex: 1, minHeight: 0, position: 'relative' }}>
            <DocumentPanelHost key={current.docId} doc={current.doc} refs={refs} vaultId={vaultId} userId={userId} />
          </div>
        </div>
      )}
    </>
  )
}

const ICON_BTN: React.CSSProperties = {
  border: 'none', background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer', display: 'inline-flex', padding: 4, borderRadius: 4,
}
