// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// Dev/debug modal: shows the current vault's K_vault (current epoch) and, if
// a document is open, its K_doc — both in the clear, base64-encoded, read
// directly from the live in-memory Keyring (EdgesyncVaultSession.debugVaultKey/
// debugDocKey — see those methods, never used by any production crypto
// path). Exists to make the epoch/rotation model tangible while developing
// on it (see AppShell.tsx's "Renouveler la clé" button) — not a feature end
// users are expected to reach for.
import { useState } from 'react'
import type { EdgesyncVaultSessionLike } from '@savoire/application'

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
  flexDirection: 'column', gap: 16,
}
const label: React.CSSProperties = {
  fontSize: 12, fontWeight: 600, color: 'var(--text-muted)', letterSpacing: '0.02em',
}
const keyBox: React.CSSProperties = {
  display: 'flex', gap: 8, alignItems: 'stretch',
}
const keyCode: React.CSSProperties = {
  flex: 1, padding: '9px 11px', background: 'var(--bg-base)', border: '1px solid var(--border)',
  borderRadius: 'var(--radius)', fontSize: 12.5, fontFamily: 'var(--font-code)', color: 'var(--text)',
  overflowWrap: 'anywhere', userSelect: 'all',
}
const copyBtn: React.CSSProperties = {
  padding: '0 14px', background: 'transparent', color: 'var(--text-muted)', border: '1px solid var(--border)',
  borderRadius: 'var(--radius)', fontSize: 13, fontWeight: 600, cursor: 'pointer', flexShrink: 0, fontFamily: 'var(--font-ui)',
}
const info: React.CSSProperties = {
  padding: '10px 14px', background: 'color-mix(in srgb, var(--color-info) 10%, var(--bg-base))',
  borderRadius: 'var(--radius)', border: '1px solid color-mix(in srgb, var(--color-info) 30%, var(--border))',
  color: 'var(--text)', fontSize: 12.5, lineHeight: 1.5,
}

function CopyableKey({ value }: { value: string }) {
  const [copied, setCopied] = useState(false)
  function copy() {
    void navigator.clipboard.writeText(value).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }
  return (
    <div style={keyBox}>
      <code style={keyCode}>{value}</code>
      <button onClick={copy} style={copyBtn}>{copied ? 'Copié' : 'Copier'}</button>
    </div>
  )
}

export interface VaultKeyDebugPanelProps {
  vaultName: string
  edgesyncVault: EdgesyncVaultSessionLike
  activeDoc: { id: string; path: string } | null
  onClose: () => void
}

export function VaultKeyDebugPanel({ vaultName, edgesyncVault, activeDoc, onClose }: VaultKeyDebugPanelProps) {
  const vaultKey = edgesyncVault.debugVaultKey()
  const docKey = activeDoc ? edgesyncVault.debugDocKey(activeDoc.id) : undefined

  return (
    <div style={overlay} onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div style={modal}>
        <div style={header}>
          <strong style={{ fontSize: '0.9rem' }}>Clés — {vaultName}</strong>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: 'var(--text-faint)', fontSize: '1.1rem', cursor: 'pointer', padding: '0 4px' }}>✕</button>
        </div>
        <div style={body}>
          <div style={info}>
            Ces clés sont lues directement en mémoire, en clair — outil de développement, jamais exposé à un utilisateur normal.
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span style={label}>K_vault {vaultKey ? `(epoch ${vaultKey.epoch})` : ''}</span>
            {vaultKey ? <CopyableKey value={vaultKey.base64} /> : (
              <span style={{ fontSize: 12.5, color: 'var(--text-faint)' }}>Aucune clé — ce pair n'a pas encore reçu de grant.</span>
            )}
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span style={label}>K_doc — fichier actif</span>
            {!activeDoc && (
              <span style={{ fontSize: 12.5, color: 'var(--text-faint)' }}>Aucun fichier ouvert.</span>
            )}
            {activeDoc && !docKey && (
              <span style={{ fontSize: 12.5, color: 'var(--text-faint)' }}>Pas de clé pour {activeDoc.path} — pas encore mintée dans cette session.</span>
            )}
            {activeDoc && docKey && (
              <>
                <span style={{ fontSize: 12, color: 'var(--text-faint)' }}>{activeDoc.path}</span>
                <CopyableKey value={docKey} />
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
