// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Les bibliotheques que Savoire fournit aux applications : React, en modules
// ES construits avec l'appli (apps/web/vite.config.ts, appLibraries) et servis
// sous /app-libs/. Le cadre les recoit en texte et en fait des adresses blob:
// (une origine opaque ne lit pas les adresses de Savoire).
import type { AppLibraries } from './frame'

/** Nom d'import -> fichier sous /app-libs/. */
export const APP_LIBRARY_FILES: Record<string, string> = {
  'react': 'react.js',
  'react-dom': 'react-dom.js',
  'react-dom/client': 'react-dom-client.js',
  'react/jsx-runtime': 'react-jsx-runtime.js',
}

let base = '/app-libs/'
let cache: Promise<AppLibraries> | null = null

/** Adresse du dossier des bibliotheques (tests, autre hote). */
export function setAppLibrariesBase(url: string): void {
  base = url.endsWith('/') ? url : `${url}/`
  cache = null
}

/** Les bibliotheques, chargees une fois. Une absente est simplement omise. */
export function loadAppLibraries(): Promise<AppLibraries> {
  if (!cache) {
    cache = (async () => {
      const out: AppLibraries = {}
      if (typeof fetch !== 'function') return out
      await Promise.all(Object.entries(APP_LIBRARY_FILES).map(async ([name, file]) => {
        try {
          const r = await fetch(base + file)
          if (r.ok) out[name] = await r.text()
        } catch { /* hors ligne, ou hote sans bibliotheques */ }
      }))
      return out
    })()
  }
  return cache
}
