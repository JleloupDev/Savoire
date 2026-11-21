// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Page de connexion : telecharger l'appli de bureau. Le bouton vise le
// systeme de l'ordinateur ; « Autres systemes » montre tous les fichiers.
// Cache dans l'appli de bureau elle-meme.

import { useState } from 'react'
import { DOWNLOADS, detectDesktopOs, downloadUrl, type DesktopOs } from './downloads'
import { isTauriRuntime } from './tauriRuntime'

export function DesktopDownload() {
  const [os] = useState<DesktopOs | null>(() => typeof navigator === 'undefined' ? null : detectDesktopOs(navigator.userAgent))
  const [all, setAll] = useState(false)
  if (isTauriRuntime()) return null
  const main = os ? DOWNLOADS[os] : null

  return (
    <div data-testid="desktop-download" style={{ marginTop: 36, position: 'relative' }}>
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
          {(Object.keys(DOWNLOADS) as DesktopOs[]).map(key => (
            <div key={key} style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
              <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--on-accent)' }}>{DOWNLOADS[key].name}</span>
              {DOWNLOADS[key].files.map(f => (
                <a key={f.file} href={downloadUrl(f.file)} style={{ fontSize: 12.5, color: 'var(--on-accent-muted)' }}>{f.label}</a>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
