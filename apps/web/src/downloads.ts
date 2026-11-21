// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Telecharger l'appli de bureau depuis la page de connexion. Les fichiers de
// la derniere Release GitHub portent des noms fixes
// (apps/desktop/scripts/release-assets.mjs) : un simple lien suffit, sans
// rien lire chez GitHub depuis la page.

export const RELEASES_URL = 'https://github.com/JleloupDev/Savoire/releases/latest'

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
