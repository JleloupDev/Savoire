// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Partager → « Web » : publier la note a une adresse publique, en lecture
// seule, mise a jour en direct a chaque modification.
import { useEffect, useState } from 'react'
import type { PublicationInfo, PublicationService } from './publication'

const BTN: React.CSSProperties = {
  padding: '5px 12px', borderRadius: 6, border: '1px solid var(--border)', background: 'transparent',
  color: 'var(--text)', fontSize: '0.8rem', cursor: 'pointer',
}
const PRIMARY: React.CSSProperties = { ...BTN, background: 'var(--accent)', borderColor: 'var(--accent)', color: '#fff', fontWeight: 600 }

export function PublishWebTab({ service, docId, path, canWrite }: { service: PublicationService; docId: string; path: string; canWrite: boolean }) {
  const [info, setInfo] = useState<PublicationInfo | null | undefined>(undefined)
  const [indexable, setIndexable] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    let alive = true
    setInfo(undefined); setError(null)
    service.status(docId).then(i => { if (alive) { setInfo(i); if (i) setIndexable(i.indexable) } }, e => { if (alive) { setInfo(null); setError(String(e?.message ?? e)) } })
    return () => { alive = false }
  }, [service, docId])

  const run = async (job: () => Promise<void>) => {
    setBusy(true); setError(null)
    try { await job() } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    setBusy(false)
  }
  const url = info ? service.publicUrl(info) : ''

  if (info === undefined) return <div style={{ fontSize: '0.78rem', color: 'var(--text-faint)' }}>…</div>
  return (
    <div data-testid="publish-web" style={{ display: 'flex', flexDirection: 'column', gap: 12, fontSize: '0.8rem' }}>
      <div style={{ color: 'var(--text-muted)', lineHeight: 1.5 }}>
        Une page publique, en lecture seule, pour toute personne qui a l’adresse. Elle suit la note en direct :
        chaque modification y apparaît quelques secondes après.
      </div>
      {info ? (
        <>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <span style={{ width: 8, height: 8, borderRadius: 4, background: 'var(--color-success, #16a34a)', flexShrink: 0 }} />
            <a data-testid="publish-url" href={url} target="_blank" rel="noopener noreferrer" style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{url}</a>
            <button style={BTN} onClick={() => { void navigator.clipboard.writeText(url); setCopied(true); setTimeout(() => setCopied(false), 1500) }}>{copied ? 'Copié' : 'Copier'}</button>
          </div>
          <div style={{ color: 'var(--text-faint)' }}>Mise à jour : {new Date(info.updatedAt).toLocaleString()}</div>
        </>
      ) : (
        <div style={{ color: 'var(--text-faint)' }}>Cette note n’est pas publiée.</div>
      )}
      <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        <input type="checkbox" data-testid="publish-indexable" checked={indexable} disabled={!canWrite || busy} onChange={e => setIndexable(e.target.checked)} />
        Visible dans les moteurs de recherche
      </label>
      {canWrite ? (
        <div style={{ display: 'flex', gap: 8 }}>
          <button data-testid="publish-submit" style={PRIMARY} disabled={busy} onClick={() => void run(async () => setInfo(await service.publish(docId, path, indexable)))}>
            {busy ? 'Publication…' : info ? 'Mettre à jour maintenant' : 'Publier sur le web'}
          </button>
          {info && (
            <button data-testid="publish-remove" style={BTN} disabled={busy} onClick={() => void run(async () => { await service.unpublish(docId); setInfo(null) })}>
              Retirer du web
            </button>
          )}
        </div>
      ) : <div style={{ color: 'var(--text-faint)' }}>Seuls les éditeurs du vault publient.</div>}
      {error && <div style={{ color: 'var(--color-danger)' }}>{error}</div>}
    </div>
  )
}
