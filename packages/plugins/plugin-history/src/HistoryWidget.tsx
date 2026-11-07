// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Panneau « Versions » de la note active, a cote de la revision : les
// versions par jour, avec leur auteur et ce qui a change. Un clic ouvre la
// version a part, sans toucher a la note ; on peut la restaurer ou la copier.
import { useEffect, useMemo, useState } from 'react'
import type { ISharedMap, ViewContext, Widget } from '@savoire/plugin-api'
import { diffLines, diffStats, listVersions, type NoteVersion } from './history'

export interface HistoryHost {
  openMap(docId: string): ISharedMap | null
  restore(docId: string, version: NoteVersion): Promise<void>
  /** Enregistre ce qui attend, pour voir la toute derniere version. */
  flush(docId: string): void
}

const time = new Intl.DateTimeFormat('fr-FR', { hour: '2-digit', minute: '2-digit' })
const longDate = new Intl.DateTimeFormat('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })

function dayLabel(iso: string): string {
  const d = new Date(iso)
  const today = new Date()
  const yesterday = new Date(); yesterday.setDate(today.getDate() - 1)
  if (d.toDateString() === today.toDateString()) return 'Aujourd\'hui'
  if (d.toDateString() === yesterday.toDateString()) return 'Hier'
  return longDate.format(d)
}

const authorName = (v: NoteVersion) => v.author?.name ?? 'Avant l\'historique'

function HistoryPanel({ ctx, host }: { ctx: ViewContext; host: HistoryHost }) {
  const [path, setPath] = useState<string | null>(() => ctx.workspace.getActiveDocument()?.path ?? null)
  const [tick, setTick] = useState(0)
  const [who, setWho] = useState<string>('')
  const [open, setOpen] = useState<NoteVersion | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => ctx.workspace.subscribeActiveDocument?.(p => { setPath(p); setOpen(null); setWho('') }), [ctx])
  const docId = path ? ctx.vault.resolveDocumentId(path) : undefined
  const map = useMemo(() => (docId ? host.openMap(docId) : null), [docId, host])
  useEffect(() => map?.onChange(() => setTick(t => t + 1)), [map])
  // A l'ouverture du panneau : la derniere frappe devient une version.
  useEffect(() => { if (docId) host.flush(docId) }, [docId, host])

  const versions = useMemo(() => (map ? listVersions(map) : []), [map, tick])
  const authors = useMemo(() => {
    const seen = new Map<string, string>()
    for (const v of versions) seen.set(v.author?.id ?? '', authorName(v))
    return [...seen]
  }, [versions])

  const shown = who ? versions.filter(v => (v.author?.id ?? '') === who) : versions
  const previousOf = (v: NoteVersion) => versions[versions.indexOf(v) + 1]

  const S = {
    panel: { height: '100%', display: 'flex', flexDirection: 'column' as const, fontSize: 12, color: 'var(--text)' },
    head: { padding: '8px 10px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 6 },
    title: { flex: 1, fontWeight: 600, fontSize: '0.7rem', textTransform: 'uppercase' as const, letterSpacing: '0.08em', color: 'var(--text-faint)' },
    body: { flex: 1, overflow: 'auto' as const, padding: '4px 0' },
    day: { padding: '8px 10px 2px', fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'capitalize' as const },
    row: { padding: '5px 10px', margin: '0 4px', borderRadius: 4, cursor: 'pointer', display: 'flex', gap: 8, alignItems: 'baseline' } as React.CSSProperties,
    muted: { padding: '12px 10px', color: 'var(--text-faint)', fontStyle: 'italic' as const },
  }

  if (!path || !docId) return <div style={S.panel}><div style={S.muted}>Ouvrez une note pour voir ses versions.</div></div>
  if (!map) return <div style={S.panel}><div style={S.muted}>Ouvrez un vault pour voir les versions.</div></div>

  let lastDay = ''
  return (
    <div style={S.panel} data-testid="history">
      <div style={S.head}>
        <span style={S.title}>Versions</span>
        {authors.length > 1 && (
          <select data-testid="history-author" value={who} onChange={e => setWho(e.target.value)}
            style={{ fontSize: 11, background: 'var(--bg-elevated)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 4 }}>
            <option value="">Tout le monde</option>
            {authors.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
          </select>
        )}
      </div>
      <div style={S.body}>
        {shown.length === 0 && <div style={S.muted}>Aucune version pour l'instant. Une version est gardée toutes les 5 minutes pendant qu'on écrit.</div>}
        {shown.map(v => {
          const day = dayLabel(v.at)
          const header = day !== lastDay ? <div style={S.day}>{day}</div> : null
          lastDay = day
          const prev = previousOf(v)
          const stats = prev ? diffStats(prev.text, v.text) : null
          return (
            <div key={v.id}>
              {header}
              <div data-testid="history-version" data-version-id={v.id} style={S.row}
                onClick={() => { setError(null); setOpen(v) }}
                onMouseEnter={e => { e.currentTarget.style.background = 'var(--bg-elevated)' }}
                onMouseLeave={e => { e.currentTarget.style.background = 'transparent' }}>
                <span style={{ fontVariantNumeric: 'tabular-nums', color: 'var(--text-muted)' }}>{time.format(new Date(v.at))}</span>
                <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {authorName(v)}{v.restoredFrom ? ' · restauration' : ''}
                </span>
                {stats && (stats.added || stats.removed) ? (
                  <span style={{ fontSize: 11, fontVariantNumeric: 'tabular-nums' }}>
                    <span style={{ color: 'var(--color-success, #1a7f37)' }}>+{stats.added}</span>{' '}
                    <span style={{ color: 'var(--color-danger, #cf222e)' }}>−{stats.removed}</span>
                  </span>
                ) : null}
              </div>
            </div>
          )
        })}
      </div>
      {open && (
        <VersionDialog
          version={open}
          previous={previousOf(open)}
          current={versions[0]}
          error={error}
          onClose={() => setOpen(null)}
          onRestore={() => {
            setError(null)
            host.restore(docId, open).then(() => setOpen(null), err => setError(err instanceof Error ? err.message : String(err)))
          }}
        />
      )}
    </div>
  )
}

function VersionDialog({ version, previous, current, error, onClose, onRestore }: {
  version: NoteVersion
  previous?: NoteVersion
  current?: NoteVersion
  error: string | null
  onClose(): void
  onRestore(): void
}) {
  const [view, setView] = useState<'changes' | 'text'>(previous ? 'changes' : 'text')
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  const lines = useMemo(() => (previous ? diffLines(previous.text, version.text) : []), [previous, version])
  const isCurrent = current?.id === version.id

  const tab = (id: 'changes' | 'text', label: string) => (
    <button onClick={() => setView(id)} disabled={id === 'changes' && !previous}
      style={{ background: 'none', border: 'none', padding: '4px 8px', cursor: 'pointer', fontSize: 12, color: view === id ? 'var(--text)' : 'var(--text-muted)', borderBottom: view === id ? '2px solid var(--accent)' : '2px solid transparent' }}>
      {label}
    </button>
  )
  const button = (primary: boolean): React.CSSProperties => ({
    fontSize: 12, padding: '5px 12px', borderRadius: 6, cursor: 'pointer', fontWeight: 600,
    border: primary ? 'none' : '1px solid var(--border)',
    background: primary ? 'var(--accent)' : 'transparent', color: primary ? 'white' : 'var(--text)',
  })

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(0,0,0,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div data-testid="history-dialog" onClick={e => e.stopPropagation()}
        style={{ width: 'min(900px, 92vw)', height: 'min(720px, 86vh)', display: 'flex', flexDirection: 'column', background: 'var(--bg-surface, var(--bg))', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 10, boxShadow: '0 12px 40px rgba(0,0,0,0.35)' }}>
        <div style={{ padding: '12px 16px 0', display: 'flex', alignItems: 'baseline', gap: 8 }}>
          <strong style={{ fontSize: 14 }}>{authorName(version)}</strong>
          <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>{longDate.format(new Date(version.at))}, {time.format(new Date(version.at))}</span>
          {version.restoredFrom && <span style={{ color: 'var(--text-faint)', fontSize: 12 }}>· restauration de la version du {longDate.format(new Date(version.restoredFrom))}</span>}
        </div>
        <div style={{ padding: '6px 12px 0', display: 'flex', gap: 4, borderBottom: '1px solid var(--border)' }}>
          {tab('changes', 'Changements')}
          {tab('text', 'Texte complet')}
        </div>
        <div style={{ flex: 1, overflow: 'auto', padding: '8px 0', fontFamily: 'var(--font-mono, ui-monospace, monospace)', fontSize: 12, lineHeight: 1.55 }}>
          {view === 'text'
            ? <pre data-testid="history-text" style={{ margin: 0, padding: '0 16px', whiteSpace: 'pre-wrap', fontFamily: 'inherit' }}>{version.text}</pre>
            : lines.map((l, i) => (
              <div key={i} data-kind={l.kind} style={{
                padding: '0 16px', whiteSpace: 'pre-wrap', minHeight: '1.55em',
                background: l.kind === 'add' ? 'rgba(46,160,67,0.15)' : l.kind === 'del' ? 'rgba(248,81,73,0.15)' : 'transparent',
                color: l.kind === 'same' ? 'var(--text-muted)' : 'var(--text)',
                textDecoration: l.kind === 'del' ? 'line-through' : 'none',
              }}>
                {l.kind === 'add' ? '+ ' : l.kind === 'del' ? '− ' : '  '}{l.text}
              </div>
            ))}
        </div>
        <div style={{ padding: '10px 16px', borderTop: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ flex: 1, color: 'var(--color-danger, #cf222e)', fontSize: 12 }}>{error}</span>
          <button style={button(false)} onClick={() => {
            void navigator.clipboard?.writeText(version.text).then(() => setCopied(true), () => {})
          }}>{copied ? 'Copié' : 'Copier le texte'}</button>
          <button style={button(false)} onClick={onClose}>Fermer</button>
          <button data-testid="history-restore" style={{ ...button(true), opacity: isCurrent ? 0.5 : 1 }} disabled={isCurrent}
            title={isCurrent ? 'C\'est déjà la version actuelle' : 'Remet ce texte dans la note, comme une modification de plus'}
            onClick={onRestore}>Restaurer cette version</button>
        </div>
      </div>
    </div>
  )
}

export class HistoryWidget implements Widget {
  constructor(private readonly ctx: ViewContext, private readonly host: HistoryHost) {}
  render() { return <HistoryPanel ctx={this.ctx} host={this.host} /> }
  dispose(): void {}
}
