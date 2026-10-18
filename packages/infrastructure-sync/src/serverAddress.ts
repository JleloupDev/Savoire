// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Adresse du serveur Savoire : le point unique ou se forment les URL du client
// (REST et SignalR).
//
// Dans le navigateur, la page vient du serveur : la base reste vide et les
// URL restent relatives (`/api/...`, `/hubs/...`). La version bureau, servie
// par Tauri, pose ici l'adresse choisie par la personne
// (`https://savoire.exemple.fr`) avant tout appel.
//
// Un client qui recoit une base explicite (option `baseUrl` / `serverUrl`)
// la garde ; sinon il lit la base commune A CHAQUE APPEL, pour suivre un
// changement de serveur sans etre recree.

let currentBase = ''

/** Pose la base commune (deja normalisee, voir normalizeServerAddress). '' = relatif. */
export function setServerBaseUrl(base: string): void {
  currentBase = base.replace(/\/+$/, '')
}

/** La base commune, '' quand les URL restent relatives. */
export function getServerBaseUrl(): string {
  return currentBase
}

/**
 * URL complete d'un chemin du serveur (`/api/v1/...`, `/hubs/...`).
 * `base` : base propre au client ; vide ou absente = base commune.
 */
export function serverUrl(path: string, base?: string | null): string {
  const b = (base || currentBase).replace(/\/+$/, '')
  if (!b) return path
  return `${b}${path.startsWith('/') ? path : `/${path}`}`
}

/** Adresse de serveur refusee : le message se montre tel quel. */
export class ServerAddressError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ServerAddressError'
  }
}

/**
 * Adresse saisie -> base propre : `https://hote[:port][/chemin]`, sans `/`
 * final. Sans schema, `https://` est suppose. Refuse les autres schemas, les
 * identifiants dans l'adresse, la requete et l'ancre.
 */
export function normalizeServerAddress(input: string): string {
  const raw = input.trim()
  if (!raw) throw new ServerAddressError('Saisissez l\'adresse du serveur.')
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`
  let url: URL
  try {
    url = new URL(withScheme)
  } catch {
    throw new ServerAddressError(`Adresse invalide : « ${raw} ».`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ServerAddressError('L\'adresse doit commencer par http:// ou https://.')
  }
  if (!url.hostname) throw new ServerAddressError(`Adresse invalide : « ${raw} ».`)
  if (url.username || url.password) {
    throw new ServerAddressError('L\'adresse ne doit pas contenir d\'identifiant ni de mot de passe.')
  }
  if (url.search || url.hash) {
    throw new ServerAddressError('L\'adresse ne doit contenir ni « ? » ni « # ».')
  }
  const path = url.pathname.replace(/\/+$/, '')
  return `${url.protocol}//${url.host}${path}`
}
