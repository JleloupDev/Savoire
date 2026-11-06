// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Preferences d'affichage personnelles (ce poste) : afficher l'extension des
// fichiers (« Genèse 2.md ») ou la cacher (« Genèse 2 », par defaut, comme
// Obsidian). Lue par l'appli (onglets, fil d'Ariane) et par les plugins
// (api.workspace.showFileExtensions, arbre des fichiers). Aussi : le delai
// avant l'apercu d'un lien survole (api.workspace.linkPreviewDelay).

import { useSyncExternalStore } from 'react'

const KEY = 'savoire-show-file-extensions'
const listeners = new Set<() => void>()

function read(): boolean {
  try { return localStorage.getItem(KEY) === '1' } catch { return false }
}

let current = read()

export function showFileExtensions(): boolean {
  return current
}

export function setShowFileExtensions(show: boolean): void {
  if (show === current) return
  current = show
  try { localStorage.setItem(KEY, show ? '1' : '0') } catch { /* navigation privee */ }
  for (const cb of [...listeners]) cb()
}

export function subscribeDisplayPreferences(cb: () => void): () => void {
  listeners.add(cb)
  return () => { listeners.delete(cb) }
}

export function useShowFileExtensions(): boolean {
  return useSyncExternalStore(subscribeDisplayPreferences, showFileExtensions)
}

// ── Apercu des liens au survol ───────────────────────────────────────────────

const PREVIEW_KEY = 'savoire-link-preview-delay'
/** Delai par defaut avant l'apercu d'un lien survole (ms). */
export const DEFAULT_LINK_PREVIEW_DELAY = 800

function readDelay(): number {
  try {
    const raw = localStorage.getItem(PREVIEW_KEY)
    const n = raw === null ? NaN : Number(raw)
    return Number.isFinite(n) && n >= 0 ? n : DEFAULT_LINK_PREVIEW_DELAY
  } catch { return DEFAULT_LINK_PREVIEW_DELAY }
}

let previewDelay = readDelay()

/** Delai avant l'apercu d'un lien survole, en ms. 0 : pas d'apercu. */
export function linkPreviewDelay(): number {
  return previewDelay
}

export function setLinkPreviewDelay(ms: number): void {
  const value = Number.isFinite(ms) && ms >= 0 ? Math.round(ms) : DEFAULT_LINK_PREVIEW_DELAY
  if (value === previewDelay) return
  previewDelay = value
  try { localStorage.setItem(PREVIEW_KEY, String(value)) } catch { /* navigation privee */ }
  for (const cb of [...listeners]) cb()
}

export function useLinkPreviewDelay(): number {
  return useSyncExternalStore(subscribeDisplayPreferences, linkPreviewDelay)
}

/** Nom affiche d'un fichier : extension cachee pour les types connus, sauf si on veut la voir. */
export function displayFileName(path: string, show = current): string {
  const name = path.slice(path.lastIndexOf('/') + 1)
  return show ? name : name.replace(/\.md$/i, '')
}
