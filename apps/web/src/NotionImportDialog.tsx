// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Fenetre « Importer depuis Notion » (ADR-035) : se connecter a Notion,
// choisir le dossier du vault, lancer, suivre, mettre en pause ou reprendre.
// L'import continue fenetre fermee (notification avec progression).
import { useEffect, useState } from 'react'
import type { NotionImportService, NotionImportStatus } from './notionImport'
import { reportText } from './notionImport'

const small: React.CSSProperties = { color: 'var(--text-muted)', fontSize: '0.8rem', lineHeight: 1.45 }

function button(primary: boolean): React.CSSProperties {
  return {
    padding: '8px 16px', borderRadius: 8, cursor: 'pointer', fontSize: '0.85rem', fontWeight: 600, fontFamily: 'var(--font-ui)',
    border: primary ? '1px solid var(--accent)' : '1px solid var(--border)',
    background: primary ? 'var(--accent)' : 'transparent',
    color: primary ? 'var(--accent-text, #fff)' : 'var(--text)',
  }
}

const link: React.CSSProperties = {
  background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontSize: '0.78rem',
  color: 'var(--text-faint)', fontFamily: 'var(--font-ui)', textDecoration: 'underline',
}

function progressLine(s: NotionImportStatus): string {
  const p = s.progress
  if (!p) return 'Préparation…'
  if (p.phase === 'plan') return p.done ? `Inventaire : ${p.done} objet(s) trouvé(s)…` : 'Inventaire des pages partagées…'
  if (p.phase === 'skeleton') return `Création de l’arborescence : ${p.done} / ${p.total}`
  if (p.phase === 'fill') return `Pages remplies : ${p.done} / ${p.total}${p.current ? ` · ${p.current}` : ''}`
  return 'Terminé.'
}

/**
 * `service` null : hors version bureau (seul l'export .zip est possible).
 * `vaultOpen` : un vault est ouvert (l'import va dedans).
 */
export function NotionImportDialog({ service, vaultOpen, onClose }: { service: NotionImportService | null; vaultOpen: boolean; onClose(): void }) {
  const [status, setStatus] = useState<NotionImportStatus | null>(service?.status ?? null)
  const [available, setAvailable] = useState<boolean | null>(null)
  const [folder, setFolder] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!service) return
    const off = service.subscribe(setStatus)
    void service.refreshWorkspace()
    void service.available().then(setAvailable)
    return off
  }, [service])

  const workspace = status?.workspace
  useEffect(() => {
    if (workspace?.workspaceName && !folder) setFolder(workspace.workspaceName)
  }, [workspace?.workspaceName]) // eslint-disable-line react-hooks/exhaustive-deps

  async function act(fn: () => Promise<unknown>) {
    setBusy(true)
    setError(null)
    try { await fn() } catch (err) { setError(err instanceof Error ? err.message : String(err)) } finally { setBusy(false) }
  }

  let body: React.ReactNode
  if (!service) {
    body = (
      <div style={small}>
        La connexion à Notion se fait depuis la version bureau de Savoire. Dans le navigateur, importez un export
        « Markdown &amp; CSV » de Notion (.zip) depuis le menu du vault.
      </div>
    )
  } else if (available === false && !workspace) {
    body = (
      <div style={small}>
        Ce serveur Savoire ne propose pas la connexion à Notion. Son administrateur doit déclarer une intégration
        Notion (Notion:ClientId et Notion:ClientSecret). En attendant, l’export .zip de Notion reste possible.
      </div>
    )
  } else if (!workspace) {
    body = (
      <>
        <div style={small}>
          Votre navigateur s’ouvre sur Notion. Connectez-vous, puis choisissez les pages à partager avec Savoire :
          leurs sous-pages et leurs bases suivent. Savoire ne fait que lire, il ne modifie jamais votre Notion.
        </div>
        <div style={{ display: 'flex', gap: 10, marginTop: 18 }}>
          <button type="button" data-testid="notion-connect" disabled={busy || available === null} onClick={() => act(() => service.connect())} style={button(true)}>
            {busy ? 'En attente de Notion…' : 'Se connecter à Notion'}
          </button>
        </div>
      </>
    )
  } else {
    const running = !!status?.running
    const pending = !!status?.pending
    body = (
      <>
        <div style={{ fontSize: '0.85rem' }}>
          Connecté à <strong>{workspace.workspaceIcon && !/^https?:/.test(workspace.workspaceIcon) ? `${workspace.workspaceIcon} ` : ''}{workspace.workspaceName || 'Notion'}</strong>
          {!running && <> · <button type="button" style={link} onClick={() => act(() => service.disconnect())}>Se déconnecter</button></>}
        </div>
        {running ? (
          <div data-testid="notion-progress" style={{ ...small, marginTop: 14 }}>{progressLine(status!)}</div>
        ) : pending ? (
          <div style={{ ...small, marginTop: 14 }}>Un import a commencé dans ce vault. Il reprend où il s’était arrêté.</div>
        ) : (
          <label style={{ display: 'block', marginTop: 14, fontSize: '0.82rem' }}>
            Dossier du vault qui recevra vos pages
            <input data-testid="notion-folder" value={folder} onChange={e => setFolder(e.target.value)} placeholder="Notion"
              style={{ display: 'block', width: '100%', boxSizing: 'border-box', marginTop: 6, padding: '7px 10px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg-base)', color: 'var(--text)', fontFamily: 'var(--font-ui)' }} />
          </label>
        )}
        {status?.report && !running && <div style={{ ...small, marginTop: 10 }}>{reportText(status.report)}</div>}
        <div style={{ ...small, marginTop: 10 }}>
          L’arborescence apparaît d’abord, puis les pages se remplissent une à une (Notion limite le débit).
          Vous pouvez fermer cette fenêtre et continuer à travailler.
        </div>
        <div style={{ display: 'flex', gap: 10, marginTop: 18 }}>
          {running ? (
            <button type="button" data-testid="notion-pause" onClick={() => service.pause()} style={button(false)}>Mettre en pause</button>
          ) : (
            <button type="button" data-testid="notion-start" disabled={!vaultOpen || busy}
              onClick={() => { void service.start(pending ? undefined : (folder.trim() || 'Notion').replace(/[\\/:*?"<>|#^[\]]+/g, ' ').trim()); }}
              style={button(true)}>
              {pending ? 'Reprendre l’import' : 'Importer'}
            </button>
          )}
        </div>
        {!vaultOpen && <div style={{ ...small, marginTop: 8 }}>Ouvrez d’abord le vault qui recevra vos pages.</div>}
      </>
    )
  }

  const shownError = error ?? status?.error ?? null
  return (
    <div data-testid="notion-import" className="sv-overlay" onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(0,0,0,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div role="dialog" aria-modal="true" aria-labelledby="notion-import-title" onClick={e => e.stopPropagation()}
        style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 12, boxShadow: '0 8px 32px rgba(0,0,0,0.24)', width: 520, maxWidth: '92vw', padding: '26px 28px 20px', color: 'var(--text)', fontFamily: 'var(--font-ui)' }}>
        <div id="notion-import-title" style={{ fontSize: '1.15rem', fontWeight: 700, marginBottom: 12 }}>Importer depuis Notion</div>
        {body}
        {shownError && <div role="alert" style={{ marginTop: 12, fontSize: '0.8rem', color: 'var(--color-danger, #f38ba8)' }}>{shownError}</div>}
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 16 }}>
          <button type="button" data-testid="notion-close" onClick={onClose} style={link}>Fermer</button>
        </div>
      </div>
    </div>
  )
}
