// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Partager un module (une note integree ailleurs). Deux facons, au choix de
// la personne (pas de defaut) :
//  - lecture seule, sur un site web : la page publique de la note, en mode
//    integre (elle suit la note en direct) ;
//  - ecriture : un lien d'edition ; le module s'edite a plusieurs depuis le
//    site qui l'integre, plugins de la note compris.
import { useState } from 'react'
import type { IVaultSharing } from '@savoire/application'
import type { PublicationService } from './publication'

const BTN: React.CSSProperties = {
  padding: '5px 12px', borderRadius: 6, border: '1px solid var(--border)', background: 'transparent',
  color: 'var(--text)', fontSize: '0.8rem', cursor: 'pointer',
}
const PRIMARY: React.CSSProperties = { ...BTN, background: 'var(--accent)', border: '1px solid var(--accent)', color: '#fff', fontWeight: 600 }

/** Le code a coller dans une page web. */
export function embedSnippet(url: string, height = 480): string {
  return `<iframe src="${url}" style="width:100%;height:${height}px;border:0" loading="lazy" title="Module Savoire"></iframe>`
}

export function ModuleShareDialog({ docId, path, publications, sharing, token, canWrite, onClose }: {
  docId: string
  path: string
  publications: PublicationService
  sharing: IVaultSharing
  token: string
  canWrite: boolean
  onClose: () => void
}) {
  const [mode, setMode] = useState<'read' | 'write' | null>(null)
  const [url, setUrl] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const name = (path.split('/').pop() ?? path).replace(/\.md$/i, '')

  const choose = async (m: 'read' | 'write') => {
    setMode(m); setUrl(null); setError(null); setBusy(true)
    try {
      if (m === 'read') {
        const info = (await publications.status(docId)) ?? await publications.publish(docId, path, false)
        setUrl(`${publications.publicUrl(info)}?embed=1`)
      } else {
        const link = await sharing.createShareLink('document', docId, 'write', token)
        setUrl(`${window.location.origin}/share/${link.token}?embed=1`)
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
    setBusy(false)
  }
  const snippet = url ? embedSnippet(url) : ''

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
      onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div data-testid="module-share" style={{ width: 540, maxWidth: 'calc(100vw - 32px)', background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 10, padding: 18, display: 'flex', flexDirection: 'column', gap: 12, fontSize: '0.82rem', color: 'var(--text)' }}>
        <div style={{ display: 'flex', alignItems: 'center' }}>
          <div style={{ flex: 1, fontWeight: 600, fontSize: '0.92rem' }}>Partager le module « {name} »</div>
          <button onClick={onClose} title="Fermer" style={{ ...BTN, border: 'none' }}>✕</button>
        </div>
        <div style={{ color: 'var(--text-muted)', lineHeight: 1.5 }}>
          Le module s’intègre dans une autre note, ou sur un site web. Choisissez ce que verront les personnes qui l’ouvrent.
        </div>
        {!canWrite && <div style={{ color: 'var(--text-faint)' }}>Seuls les éditeurs du vault partagent un module.</div>}
        <div style={{ display: 'flex', gap: 8 }}>
          <button data-testid="module-share-read" style={mode === 'read' ? PRIMARY : BTN} disabled={!canWrite || busy} onClick={() => void choose('read')}>
            Lecture seule
          </button>
          <button data-testid="module-share-write" style={mode === 'write' ? PRIMARY : BTN} disabled={!canWrite || busy} onClick={() => void choose('write')}>
            Écriture
          </button>
        </div>
        {mode === 'read' && <div style={{ color: 'var(--text-muted)' }}>Tout le monde peut le lire. Il suit la note en direct (mis à jour chaque minute sur le site).</div>}
        {mode === 'write' && <div style={{ color: 'var(--text-muted)' }}>Toute personne qui a ce lien peut modifier la note, à plusieurs et en direct. Le lien se retire dans Partager → Liens.</div>}
        {busy && <div style={{ color: 'var(--text-faint)' }}>…</div>}
        {url && (
          <>
            <label style={{ fontWeight: 600 }}>Adresse</label>
            <input data-testid="module-share-url" readOnly value={url} style={{ padding: '5px 8px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg-elevated)', color: 'var(--text)', fontSize: 12 }} />
            <label style={{ fontWeight: 600 }}>Code à coller dans une page web</label>
            <textarea data-testid="module-share-snippet" readOnly value={snippet} rows={3} style={{ padding: 8, borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg-elevated)', color: 'var(--text)', fontFamily: 'var(--font-mono, monospace)', fontSize: 11, resize: 'none' }} />
            <div><button style={BTN} onClick={() => { void navigator.clipboard.writeText(snippet); setCopied(true); setTimeout(() => setCopied(false), 1500) }}>{copied ? 'Copié' : 'Copier le code'}</button></div>
          </>
        )}
        {error && <div style={{ color: 'var(--color-danger)' }}>{error}</div>}
      </div>
    </div>
  )
}
