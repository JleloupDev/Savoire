// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Comptes de test chez le fournisseur d'identite de dev (Zitadel, ADR-028),
// sans navigateur. Les comptes se creent chez Zitadel (jeton admin) ; la
// connexion suit le vrai parcours de l'appli (HttpAuthBackend : code +
// PKCE), la page de connexion etant remplacee par l'API de sessions de
// Zitadel (jeton du client de connexion).
//
// Prerequis : deploy/compose/docker-compose.dev.yml lance ; son service
// zitadel-bootstrap ecrit .local/zitadel/dev-admin.pat et dev-login.pat.
// Autres emplacements : ZITADEL_ADMIN_PAT_FILE, ZITADEL_LOGIN_PAT_FILE.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AppAuthResponse } from '@savoire/application'
import { HttpAuthBackend } from '@savoire/infrastructure-sync'

const SERVER_URL = process.env.SERVER_URL ?? 'http://localhost:5000'
const REPO = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../../../../..')

/** L'administrateur de dev : admin de Zitadel, et de Savoire (Auth:AdminEmails). */
export const ADMIN_EMAIL = 'admin@savoire.localhost'
export const ADMIN_LOGIN = ADMIN_EMAIL
export const ADMIN_PASSWORD = 'Admin-Dev-1234!'

/** Un mot de passe accepte par la politique de Zitadel. */
export const TEST_PASSWORD = 'Test-Pass-1234!'

const REDIRECT_URI = 'http://localhost:3002/auth/callback'

function pat(envName: string, file: string): string {
  const path = process.env[envName] ?? resolve(REPO, '.local/zitadel', file)
  return readFileSync(path, 'utf8').trim()
}

async function issuer(): Promise<string> {
  const res = await fetch(`${SERVER_URL}/api/v1/auth/config`)
  if (!res.ok) throw new Error(`auth/config : ${res.status}`)
  return ((await res.json()) as { issuer: string }).issuer
}

async function zitadel(path: string, token: string, body: unknown): Promise<Response> {
  return fetch(`${await issuer()}${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

/**
 * Cree le compte (adresse verifiee, mot de passe donne) s'il n'existe pas.
 * Identifiant de connexion : l'adresse.
 */
export async function ensureDevUser(email: string, password: string, displayName: string): Promise<void> {
  const [given, ...rest] = displayName.split(' ')
  const res = await zitadel('/v2/users/human', pat('ZITADEL_ADMIN_PAT_FILE', 'dev-admin.pat'), {
    username: email,
    profile: { givenName: given || displayName, familyName: rest.join(' ') || '-', displayName },
    email: { email, isVerified: true },
    password: { password, changeRequired: false },
  })
  // 409 : deja la.
  if (!res.ok && res.status !== 409) throw new Error(`creation de ${email} : ${res.status} ${await res.text()}`)
}

/**
 * Connexion sans navigateur : renvoie ce que l'appli recoit (jetons et compte
 * Savoire, cree a la premiere connexion). Rejette si le mot de passe est faux.
 */
export async function devLogin(loginName: string, password: string): Promise<AppAuthResponse> {
  const auth = new HttpAuthBackend(SERVER_URL, 'web')
  const { url, pending } = await auth.beginLogin(REDIRECT_URI, 'login')
  const authorize = await fetch(url, { redirect: 'manual' })
  const location = authorize.headers.get('location')
  const requestId = location ? new URL(location, url).searchParams.get('authRequest') : null
  if (!requestId) throw new Error(`autorisation : pas de demande de connexion (${authorize.status})`)

  const loginToken = pat('ZITADEL_LOGIN_PAT_FILE', 'dev-login.pat')
  const session = await zitadel('/v2/sessions', loginToken, {
    checks: { user: { loginName }, password: { password } },
  })
  if (!session.ok) throw new Error(`connexion refusee (${session.status})`)
  const { sessionId, sessionToken } = await session.json() as { sessionId: string; sessionToken: string }

  const done = await zitadel(`/v2/oidc/auth_requests/${requestId}`, loginToken, { session: { sessionId, sessionToken } })
  if (!done.ok) throw new Error(`fin de connexion : ${done.status} ${await done.text()}`)
  const { callbackUrl } = await done.json() as { callbackUrl: string }
  return auth.completeLogin(pending, new URL(callbackUrl).searchParams)
}
