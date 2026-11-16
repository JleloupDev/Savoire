// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Lire une page web depuis un plugin.
//
// Un navigateur ne lit pas un autre site que celui de l'application (CORS) :
// seule l'application bureau fournit cet acces, par son processus natif.
// Sur le web, `api.network` est absent.
//
// Droit : 'network:*', ou 'network:<site>' (le site exact, sans sous-domaine
// implicite). Seul https est accepte.

export interface NetworkAPI {
  /** Le texte (UTF-8) d'une page https. Rejette si la page ne repond pas 200. */
  fetchText(url: string): Promise<string>
}

/** Le site d'une adresse https, ou null si l'adresse n'en est pas une. */
export function httpsHost(url: string): string | null {
  try {
    const u = new URL(url)
    return u.protocol === 'https:' && !u.username && !u.password ? u.hostname.toLowerCase() : null
  } catch {
    return null
  }
}

/** Les droits autorisent-ils cette adresse ? */
export function networkAllowed(permissions: Iterable<string>, url: string): boolean {
  const host = httpsHost(url)
  if (!host) return false
  for (const p of permissions) {
    if (p === 'network:*' || p === `network:${host}`) return true
  }
  return false
}
