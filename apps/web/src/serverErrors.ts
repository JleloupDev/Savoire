// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Une erreur de connexion au serveur, dite en clair pour l'ecran de connexion.

/** Code HTTP porte par le message (« 401 », « HTTP 404 », « 500: ... »), ou null. */
export function httpStatusOf(err: unknown): number | null {
  const msg = err instanceof Error ? err.message : String(err)
  const m = /^(?:HTTP )?(\d{3})\b/.exec(msg.trim())
  return m ? Number(m[1]) : null
}

/**
 * Erreur reseau (fetch rejete avant toute reponse) : serveur injoignable,
 * adresse fausse, certificat refuse, origine refusee par CORS. Le navigateur
 * ne dit pas laquelle, volontairement.
 */
export function isNetworkError(err: unknown): boolean {
  return err instanceof TypeError
}

export type LoginErrorKind = 'credentials' | 'unreachable' | 'not-savoire' | 'server' | 'other'

export function classifyLoginError(err: unknown): LoginErrorKind {
  if (isNetworkError(err)) return 'unreachable'
  // Une page HTML a la place de JSON : ce n'est pas l'API de Savoire.
  if (err instanceof SyntaxError) return 'not-savoire'
  const status = httpStatusOf(err)
  if (status === 401 || status === 400) return 'credentials'
  if (status === 404 || status === 405) return 'not-savoire'
  if (status !== null && status >= 500) return 'server'
  return 'other'
}

/**
 * Le message montre a la personne. `server` : l'adresse essayee (version
 * bureau), absente dans le navigateur. `credentials` : message deja traduit.
 */
export function describeLoginError(err: unknown, opts: { server?: string | null; credentials: string }): string {
  const where = opts.server ? ` ${opts.server}` : ''
  switch (classifyLoginError(err)) {
    case 'credentials':
      return opts.credentials
    case 'unreachable':
      return opts.server
        ? `Impossible de joindre le serveur${where}. Vérifiez l'adresse (http:// ou https://, port), le réseau, `
          + 'et, en https, que le certificat du serveur est valide. Le serveur doit aussi accepter '
          + "l'application de bureau (réglage DesktopAppOrigins)."
        : 'Impossible de joindre le serveur. Vérifiez votre connexion.'
    case 'not-savoire':
      return `Cette adresse répond, mais ce n'est pas un serveur Savoire${opts.server ? ` (${opts.server})` : ''}. Vérifiez l'adresse.`
    case 'server':
      return `Le serveur${where} a rencontré une erreur (${httpStatusOf(err)}). Réessayez plus tard.`
    default: {
      const msg = err instanceof Error ? err.message : String(err)
      return `Erreur serveur : ${msg}`
    }
  }
}
