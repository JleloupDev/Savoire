// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Page de connexion : telecharger l'appli de bureau. Le bouton vise le
// systeme de l'ordinateur ; « Autres systemes » montre tous les fichiers.
// Seuls les fichiers vraiment publies sont proposes (downloads.ts).
// Cache dans l'appli de bureau elle-meme.

import { useEffect, useState } from 'react'
import { availableDownloads, detectDesktopOs, downloadUrl, fetchPublishedFiles, type DesktopOs } from './downloads'
import { isTauriRuntime } from './tauriRuntime'

export function DesktopDownload() {
  const [os] = useState<DesktopOs | null>(() => typeof navigator === 'undefined' ? null : detectDesktopOs(navigator.userAgent))
  const [all, setAll] = useState(false)
  // undefined : on demande encore a GitHub.
  const [published, setPublished] = useState<string[] | null | undefined>(undefined)
  const desktop = isTauriRuntime()

  useEffect(() => {
    if (desktop) return
    let stopped = false
    void fetchPublishedFiles().then(files => { if (!stopped) setPublished(files) })
    return () => { stopped = true }
  }, [desktop])

  if (desktop || published === undefined) return null

  const downloads = availableDownloads(published)
  const systems = (Object.keys(downloads) as DesktopOs[]).filter(key => downloads[key].files.length > 0)
  if (systems.length === 0) {
    return (
      <div data-testid="desktop-download" data-state="none" style={{ marginTop: 36, position: 'relative', fontSize: 13, color: 'var(--on-accent-muted)' }}>
        Application de bureau : bientôt disponible.
      </div>
    )
  }
  const main = os && downloads[os].files.length > 0 ? downloads[os] : null

  return (
    <div data-testid="desktop-download" data-state="ready" style={{ marginTop: 36, position: 'relative' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
        {main && (
          <a
            data-testid="desktop-download-main"
            href={downloadUrl(main.files[0].file)}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 8, padding: '9px 16px', borderRadius: 8, background: 'var(--on-accent)', color: 'var(--accent)', fontSize: 13.5, fontWeight: 600, textDecoration: 'none' }}
          >
            <span aria-hidden>⤓</span> Télécharger pour {main.name}
          </a>
        )}
        <button
          data-testid="desktop-download-all"
          onClick={() => setAll(v => !v)}
          aria-expanded={all}
          style={{ padding: 0, border: 'none', background: 'transparent', color: 'var(--on-accent)', fontSize: 13, textDecoration: 'underline', cursor: 'pointer', fontFamily: 'var(--font-ui)' }}
        >
          {main ? 'Autres systèmes' : "Télécharger l'application de bureau"}
        </button>
      </div>
      {all && (
        <div data-testid="desktop-download-list" style={{ marginTop: 14, display: 'flex', gap: 28, flexWrap: 'wrap' }}>
          {systems.map(key => (
            <div key={key} style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
              <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--on-accent)' }}>{downloads[key].name}</span>
              {downloads[key].files.map(f => (
                <a key={f.file} href={downloadUrl(f.file)} style={{ fontSize: 12.5, color: 'var(--on-accent-muted)' }}>{f.label}</a>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
