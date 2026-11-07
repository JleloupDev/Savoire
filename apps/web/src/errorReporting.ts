// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Suivi des erreurs de l'appli (web et bureau). Le serveur dit ou envoyer les
// rapports (GET /api/v1/errors/config) ; sans reglage chez lui, rien ne part.
// Les rapports passent par l'API (POST /api/v1/errors/envelope), qui les
// relaie a GlitchTip : aucun autre domaine n'est contacte.
//
// Jamais le contenu des notes : ni corps de requete, ni journaux de la
// console, ni donnees personnelles. La pile d'appels, le navigateur, la page.
import { serverUrl } from '@savoire/infrastructure-sync'

interface ErrorReportingConfig { dsn?: string | null; environment?: string | null; release?: string | null }

let started = false

/** Branche le suivi des erreurs si le serveur le demande. Sans effet la deuxieme fois. */
export async function startErrorReporting(): Promise<void> {
  if (started) return
  let config: ErrorReportingConfig
  try {
    const res = await fetch(serverUrl('/api/v1/errors/config'))
    if (!res.ok) return
    config = await res.json() as ErrorReportingConfig
  } catch {
    // Pas de serveur (bureau hors ligne, vault local) : rien a faire.
    return
  }
  if (!config.dsn || started) return
  started = true
  const Sentry = await import('@sentry/browser')
  Sentry.init({
    dsn: config.dsn,
    tunnel: serverUrl('/api/v1/errors/envelope'),
    environment: config.environment ?? undefined,
    release: config.release ?? undefined,
    // Rien de personnel ni de contenu : ni utilisateur, ni cookies, ni en-tetes,
    // ni corps de requete, ni parametres d'adresse.
    dataCollection: { userInfo: false, cookies: false, httpHeaders: false, httpBodies: [], urlQueryParams: false },
    tracesSampleRate: 0,
    beforeBreadcrumb: crumb => (crumb.category === 'console' ? null : crumb),
  })
}
