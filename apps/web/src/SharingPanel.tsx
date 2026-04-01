// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// SharingPanel — modal pour gérer les permissions et les liens de partage
// d'un vault ou d'un document.

import { useState, useEffect, useCallback } from 'react'
import { api } from './api'
import type { ResourceSharingDto, ResourcePermissionDto, ShareLinkDto, VaultSummary, DocumentDto } from './types'

// ── Styles ────────────────────────────────────────────────────────────────────

const overlay: React.CSSProperties = {
  position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 1000,
  display: 'flex', alignItems: 'center', justifyContent: 'center',
}
const modal: React.CSSProperties = {
  background: 'var(--bg-surface)', border: '1px solid var(--border)',
  borderRadius: 'var(--radius)', boxShadow: 'var(--shadow)',
  width: 520, maxHeight: '80vh', display: 'flex', flexDirection: 'column',
  overflow: 'hidden',
}
const header: React.CSSProperties = {
  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
  padding: '12px 16px', borderBottom: '1px solid var(--border)',
  flexShrink: 0,
}
const body: React.CSSProperties = {
  padding: '14px 16px', overflowY: 'auto', flex: 1, display: 'flex',
  flexDirection: 'column', gap: 14,
}
const row: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 8, fontSize: '0.8rem',
}
const inp: React.CSSProperties = {
  flex: 1, padding: '4px 8px', background: 'var(--bg-elevated)',
  color: 'var(--text)', border: '1px solid var(--border)',
  borderRadius: 'var(--radius)', fontSize: '0.8rem', outline: 'none',
}
const sel: React.CSSProperties = {
  padding: '4px 6px', background: 'var(--bg-elevated)', color: 'var(--text)',
  border: '1px solid var(--border)', borderRadius: 'var(--radius)', fontSize: '0.8rem',
}
const btnPrimary: React.CSSProperties = {
  padding: '4px 10px', background: 'var(--accent)', color: '#fff',
  border: 'none', borderRadius: 'var(--radius)', fontSize: '0.78rem', cursor: 'pointer',
}
const btnGhost: React.CSSProperties = {
  padding: '3px 8px', background: 'transparent', color: 'var(--text-muted)',
  border: '1px solid var(--border)', borderRadius: 'var(--radius)', fontSize: '0.75rem',
  cursor: 'pointer',
}
const btnDanger: React.CSSProperties = {
  ...btnGhost, color: 'var(--color-danger)', borderColor: 'var(--color-danger)',
}
const label: React.CSSProperties = {
  fontSize: '0.68rem', fontWeight: 700, color: 'var(--text-faint)',
  textTransform: 'uppercase', letterSpacing: '0.08em',
}
const permBadge = (p: string): React.CSSProperties => ({
  fontSize: '0.65rem', padding: '1px 6px', borderRadius: 10,
  background: p === 'admin' ? 'var(--accent-dim)' : p === 'write' ? 'rgba(21,128,61,0.15)' : 'rgba(37,99,235,0.12)',
  color: p === 'admin' ? 'var(--accent)' : p === 'write' ? 'var(--color-success)' : 'var(--color-info)',
  fontWeight: 600,
})

// ── Helpers ───────────────────────────────────────────────────────────────────

function linkUrl(token: string): string {
  return `${window.location.origin}/share/${token}`
}

function fmtDate(s: string | null): string {
  if (!s) return '—'
  return new Date(s).toLocaleDateString()
}

// ── Sub-components ────────────────────────────────────────────────────────────

function PermissionRow({ p, onRevoke }: { p: ResourcePermissionDto; onRevoke: () => void }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0', borderBottom: '1px solid var(--border)', fontSize: '0.8rem' }}>
      <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {p.subjectDisplayName ?? p.subjectId}
        <span style={{ fontSize: '0.68rem', color: 'var(--text-faint)', marginLeft: 6 }}>{p.subjectId}</span>
      </span>
      <span style={permBadge(p.permission)}>{p.permission}</span>
      {p.expiresAt && <span style={{ fontSize: '0.68rem', color: 'var(--text-faint)' }}>exp. {fmtDate(p.expiresAt)}</span>}
      <button style={btnDanger} onClick={onRevoke}>Révoquer</button>
    </div>
  )
}

function LinkRow({ link, onRevoke }: { link: ShareLinkDto; onRevoke: () => void }) {
  const [copied, setCopied] = useState(false)
  const copy = () => {
    void navigator.clipboard.writeText(linkUrl(link.token))
    setCopied(true); setTimeout(() => setCopied(false), 1500)
  }
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0', borderBottom: '1px solid var(--border)', fontSize: '0.8rem' }}>
      <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: 'var(--font-code)', fontSize: '0.72rem', color: 'var(--text-muted)' }}>
        {linkUrl(link.token)}
      </span>
      <span style={permBadge(link.permission)}>{link.permission}</span>
      {link.expiresAt && <span style={{ fontSize: '0.68rem', color: 'var(--text-faint)' }}>exp. {fmtDate(link.expiresAt)}</span>}
      <button style={btnGhost} onClick={copy}>{copied ? '✓' : 'Copier'}</button>
      <button style={btnDanger} onClick={onRevoke}>Révoquer</button>
    </div>
  )
}

// ── Main panel ────────────────────────────────────────────────────────────────

export interface SharingTarget {
  type: 'vault' | 'document'
  id: string
  name: string
}

interface Props {
  token: string
  vault: VaultSummary | null
  document: DocumentDto | null
  onClose: () => void
}

export function SharingPanel({ token, vault, document: doc, onClose }: Props) {
  // Which resource to manage: vault or document
  const [target, setTarget] = useState<'vault' | 'document'>(doc ? 'document' : 'vault')
  const [tab, setTab] = useState<'permissions' | 'links'>('permissions')
  const [sharing, setSharing] = useState<ResourceSharingDto | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Grant form
  const [grantSubjectId, setGrantSubjectId] = useState('')
  const [grantPermission, setGrantPermission] = useState('read')
  const [grantBusy, setGrantBusy] = useState(false)

  // Link form
  const [linkPermission, setLinkPermission] = useState('read')
  const [linkBusy, setLinkBusy] = useState(false)

  const resourceId = target === 'vault' ? vault?.id : doc?.id
  const resourceName = target === 'vault' ? vault?.name : doc?.path

  const reload = useCallback(async () => {
    if (!resourceId) return
    setLoading(true); setError(null)
    try {
      const data = await api.getSharing(target, resourceId, token)
      setSharing(data)
    } catch (e) {
      setError(String(e))
    } finally {
      setLoading(false)
    }
  }, [target, resourceId, token])

  useEffect(() => { void reload() }, [reload])

  async function handleGrant() {
    if (!resourceId || !grantSubjectId.trim()) return
    setGrantBusy(true)
    try {
      await api.grantPermission(target, resourceId, grantSubjectId.trim(), grantPermission, token)
      setGrantSubjectId('')
      await reload()
    } catch (e) { setError(String(e)) }
    finally { setGrantBusy(false) }
  }

  async function handleRevokePerm(p: ResourcePermissionDto) {
    if (!resourceId) return
    try {
      await api.revokePermission(target, resourceId, p.subjectId, token)
      await reload()
    } catch (e) { setError(String(e)) }
  }

  async function handleCreateLink() {
    if (!resourceId) return
    setLinkBusy(true)
    try {
      await api.createShareLink(target, resourceId, linkPermission, token)
      await reload()
    } catch (e) { setError(String(e)) }
    finally { setLinkBusy(false) }
  }

  async function handleRevokeLink(link: ShareLinkDto) {
    try {
      await api.revokeShareLink(link.id, token)
      await reload()
    } catch (e) { setError(String(e)) }
  }

  const activeLinks = sharing?.links.filter(l => l.isValid) ?? []

  return (
    <div style={overlay} onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div style={modal}>

        {/* Header */}
        <div style={header}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <span style={{ fontWeight: 600, fontSize: '0.9rem' }}>Partager</span>
            <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>{resourceName}</span>
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            {/* Resource selector */}
            {vault && doc && (
              <select style={sel} value={target} onChange={e => setTarget(e.target.value as 'vault' | 'document')}>
                <option value="document">Note</option>
                <option value="vault">Vault</option>
              </select>
            )}
            <button onClick={onClose} style={{ background: 'none', border: 'none', color: 'var(--text-faint)', fontSize: '1.1rem', cursor: 'pointer', padding: '0 4px' }}>✕</button>
          </div>
        </div>

        {/* Tabs */}
        <div style={{ display: 'flex', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
          {(['permissions', 'links'] as const).map(t => (
            <button key={t} onClick={() => setTab(t)} style={{ padding: '8px 16px', background: 'none', border: 'none', borderBottom: tab === t ? '2px solid var(--accent)' : '2px solid transparent', color: tab === t ? 'var(--text)' : 'var(--text-muted)', fontSize: '0.8rem', cursor: 'pointer', fontWeight: tab === t ? 600 : 400 }}>
              {t === 'permissions' ? `Utilisateurs${sharing ? ` (${sharing.permissions.length})` : ''}` : `Liens${sharing ? ` (${activeLinks.length})` : ''}`}
            </button>
          ))}
        </div>

        {/* Body */}
        <div style={body}>
          {error && <div style={{ color: 'var(--color-danger)', fontSize: '0.78rem' }}>{error}</div>}
          {loading && <div style={{ color: 'var(--text-faint)', fontSize: '0.78rem' }}>Chargement…</div>}

          {tab === 'permissions' && (
            <>
              {/* Add user form */}
              <div>
                <div style={{ ...label, marginBottom: 8 }}>Ajouter un utilisateur</div>
                <div style={row}>
                  <input style={inp} placeholder="ID utilisateur" value={grantSubjectId} onChange={e => setGrantSubjectId(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') void handleGrant() }} />
                  <select style={sel} value={grantPermission} onChange={e => setGrantPermission(e.target.value)}>
                    <option value="read">Lecture</option>
                    <option value="write">Écriture</option>
                    <option value="admin">Admin</option>
                  </select>
                  <button style={btnPrimary} onClick={() => void handleGrant()} disabled={grantBusy || !grantSubjectId.trim()}>
                    {grantBusy ? '…' : 'Ajouter'}
                  </button>
                </div>
              </div>

              {/* Permissions list */}
              <div>
                <div style={{ ...label, marginBottom: 4 }}>Accès actuels</div>
                {!sharing || sharing.permissions.length === 0
                  ? <div style={{ color: 'var(--text-faint)', fontSize: '0.78rem' }}>Aucun accès partagé.</div>
                  : sharing.permissions.map(p => (
                    <PermissionRow key={p.id} p={p} onRevoke={() => void handleRevokePerm(p)} />
                  ))
                }
              </div>
            </>
          )}

          {tab === 'links' && (
            <>
              {/* Create link form */}
              <div>
                <div style={{ ...label, marginBottom: 8 }}>Créer un lien de partage</div>
                <div style={row}>
                  <select style={sel} value={linkPermission} onChange={e => setLinkPermission(e.target.value)}>
                    <option value="read">Lecture</option>
                    <option value="write">Écriture</option>
                  </select>
                  <button style={btnPrimary} onClick={() => void handleCreateLink()} disabled={linkBusy}>
                    {linkBusy ? '…' : 'Créer le lien'}
                  </button>
                </div>
              </div>

              {/* Links list */}
              <div>
                <div style={{ ...label, marginBottom: 4 }}>Liens actifs</div>
                {activeLinks.length === 0
                  ? <div style={{ color: 'var(--text-faint)', fontSize: '0.78rem' }}>Aucun lien actif.</div>
                  : activeLinks.map(link => (
                    <LinkRow key={link.id} link={link} onRevoke={() => void handleRevokeLink(link)} />
                  ))
                }
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
