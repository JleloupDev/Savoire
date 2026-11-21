// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Telecharger l'appli de bureau depuis la page de connexion. Les fichiers de
// la derniere Release GitHub portent des noms fixes
// (apps/desktop/scripts/release-assets.mjs) : un simple lien suffit. La page
// demande seulement a l'API de GitHub quels fichiers existent, pour ne pas
// proposer un lien qui mene a une page 404 (aucune Release, fichier absent).

export const RELEASES_URL = 'https://github.com/JleloupDev/Savoire/releases/latest'
export const LATEST_RELEASE_API = 'https://api.github.com/repos/JleloupDev/Savoire/releases/latest'

/**
 * Les fichiers de la derniere Release : leurs noms, [] s'il n'y a pas
 * encore de Release, null si GitHub ne repond pas (on garde alors les liens).
 */
export async function fetchPublishedFiles(fetchImpl: typeof fetch = fetch): Promise<string[] | null> {
  try {
    const res = await fetchImpl(LATEST_RELEASE_API, { headers: { Accept: 'application/vnd.github+json' } })
    if (res.status === 404) return []
    if (!res.ok) return null
    const body = await res.json() as { assets?: { name?: unknown }[] }
    return (body.assets ?? []).map(a => a.name).filter((n): n is string => typeof n === 'string')
  } catch {
    return null
  }
}

/** Les telechargements a montrer : tous si on ne sait pas, sinon ceux publies. */
export function availableDownloads(published: string[] | null): Record<DesktopOs, { name: string; files: DownloadFile[] }> {
  if (published === null) return DOWNLOADS
  const have = new Set(published)
  const out = {} as Record<DesktopOs, { name: string; files: DownloadFile[] }>
  for (const os of Object.keys(DOWNLOADS) as DesktopOs[]) {
    out[os] = { name: DOWNLOADS[os].name, files: DOWNLOADS[os].files.filter(f => have.has(f.file)) }
  }
  return out
}

export type DesktopOs = 'windows' | 'macos' | 'linux'

export interface DownloadFile {
  label: string
  file: string
}

export const DOWNLOADS: Record<DesktopOs, { name: string; files: DownloadFile[] }> = {
  windows: { name: 'Windows', files: [
    { label: 'Installeur (.exe)', file: 'Savoire-windows-x64-setup.exe' },
    { label: 'Paquet MSI (.msi)', file: 'Savoire-windows-x64.msi' },
  ] },
  macos: { name: 'macOS', files: [
    { label: 'Mac Apple Silicon (.dmg)', file: 'Savoire-macos-arm64.dmg' },
  ] },
  linux: { name: 'Linux', files: [
    { label: 'AppImage (toutes distributions)', file: 'Savoire-linux-x86_64.AppImage' },
    { label: 'Debian, Ubuntu (.deb)', file: 'Savoire-linux-amd64.deb' },
    { label: 'Fedora, openSUSE (.rpm)', file: 'Savoire-linux-x86_64.rpm' },
  ] },
}

export function downloadUrl(file: string): string {
  return `${RELEASES_URL}/download/${file}`
}

/** Le systeme de l'ordinateur, ou null (telephone, tablette, inconnu). */
export function detectDesktopOs(userAgent: string): DesktopOs | null {
  if (/Android|iPhone|iPad|iPod|Mobile/i.test(userAgent)) return null
  if (/Windows/i.test(userAgent)) return 'windows'
  if (/Macintosh|Mac OS X/i.test(userAgent)) return 'macos'
  if (/CrOS/i.test(userAgent)) return null
  if (/Linux|X11/i.test(userAgent)) return 'linux'
  return null
}
