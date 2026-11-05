// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Aller chez le fournisseur d'identite du serveur, et en revenir (ADR-028).
//
// - Navigateur (et Android) : la page part chez le fournisseur et revient sur
//   /auth/callback ; l'etat PKCE attend dans sessionStorage.
// - Bureau : la page reste ; le navigateur du systeme s'ouvre, le
//   fournisseur revient sur http://127.0.0.1:<port>/callback, ou la coquille
//   Rust attend (RFC 8252). Recommande pour les applis natives : la
//   personne se connecte dans son navigateur habituel (gestionnaire de mots
//   de passe, connexion Google ou GitHub deja ouverte).
//
// Sans React, pour etre teste. AuthContext.tsx le branche.

import type { AppAuthResponse, IAuthAPI, LoginPrompt, PendingLogin } from '@savoire/application'
import { httpStatusOf, isNetworkError } from './serverErrors'

export const CALLBACK_PATH = '/auth/callback'
export const PENDING_KEY = 'savoire.oidc.pending'

export interface LoginDriver {
  /** Rend le compte connecte, ou null si la page part (redirection). */
  start(auth: IAuthAPI, prompt?: LoginPrompt): Promise<AppAuthResponse | null>
  /** Retour sur /auth/callback (navigateur) : le compte, ou null si ce n'est pas le notre. */
  complete(auth: IAuthAPI, callback: URLSearchParams): Promise<AppAuthResponse | null>
  /**
   * Fin de la session du fournisseur (navigateur : redirection). `idToken` :
   * la session a fermer ; sans lui, le fournisseur demande laquelle.
   */
  endSession?(auth: IAuthAPI, idToken?: string): Promise<void>
}

/** Parametres du retour du fournisseur, si la page est /auth/callback. */
export function readLoginCallback(location: { pathname: string; search: string } = window.location): URLSearchParams | null {
  return location.pathname === CALLBACK_PATH ? new URLSearchParams(location.search) : null
}

interface BrowserPort {
  origin: string
  assign(url: string): void
  /** Remplace l'adresse affichee (sans recharger). */
  replace(path: string): void
  storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null
}

function browserPort(): BrowserPort {
  let storage: BrowserPort['storage'] = null
  try { storage = window.sessionStorage } catch { /* stockage indisponible */ }
  return {
    origin: window.location.origin,
    assign: url => window.location.assign(url),
    replace: path => window.history.replaceState(null, '', path),
    storage,
  }
}

/** Navigateur : redirection vers le fournisseur, retour sur /auth/callback. */
export function redirectLoginDriver(port: BrowserPort = browserPort()): LoginDriver {
  return {
    async start(auth, prompt) {
      const { url, pending } = await auth.beginLogin(port.origin + CALLBACK_PATH, prompt)
      port.storage?.setItem(PENDING_KEY, JSON.stringify(pending))
      port.assign(url)
      return null
    },
    async complete(auth, callback) {
      const raw = port.storage?.getItem(PENDING_KEY) ?? null
      port.storage?.removeItem(PENDING_KEY)
      // L'adresse de retour (code, state) ne reste pas dans l'historique.
      port.replace('/')
      if (!raw) throw new Error('Connexion expirée : recommencez.')
      const pending = JSON.parse(raw) as PendingLogin
      return auth.completeLogin(pending, callback)
    },
    async endSession(auth, idToken) {
      try {
        const url = await auth.endSessionUrl(port.origin + '/', idToken)
        if (url) port.assign(url)
      } catch { /* fournisseur injoignable : la session locale est deja fermee */ }
    },
  }
}

/** Ce que la coquille bureau (Rust) fournit : voir src-tauri/src/oauth.rs. */
export interface LoopbackBridge {
  /** Ecoute sur 127.0.0.1, port choisi par le systeme ; rend le port. */
  listen(): Promise<number>
  /** Ouvre l'adresse dans le navigateur du systeme. */
  open(url: string): Promise<void>
  /** Attend le retour (query string du /callback) ; rejette au bout du delai. */
  wait(timeoutSecs: number): Promise<string>
}

/** Delai laisse a la personne pour se connecter dans son navigateur. */
export const LOOPBACK_TIMEOUT_SECS = 600

/**
 * Bureau : navigateur du systeme, retour sur 127.0.0.1. Par defaut, le
 * fournisseur propose de choisir le compte : le navigateur peut deja etre
 * connecte avec un autre.
 */
export function loopbackLoginDriver(bridge: LoopbackBridge): LoginDriver {
  return {
    async start(auth, prompt) {
      const port = await bridge.listen()
      const { url, pending } = await auth.beginLogin(`http://127.0.0.1:${port}/callback`, prompt ?? 'select_account')
      await bridge.open(url)
      const query = await bridge.wait(LOOPBACK_TIMEOUT_SECS)
      return auth.completeLogin(pending, new URLSearchParams(query))
    },
    async complete() {
      return null
    },
  }
}

interface TauriInternals { invoke(cmd: string, args?: Record<string, unknown>): Promise<unknown> }

/** Le pont vers les commandes Rust (oauth_listen, open_external, oauth_wait). */
export function tauriLoopbackBridge(scope: unknown = globalThis): LoopbackBridge {
  const invoke = (cmd: string, args?: Record<string, unknown>) => {
    const internals = (scope as { __TAURI_INTERNALS__?: TauriInternals }).__TAURI_INTERNALS__
    if (!internals) return Promise.reject(new Error('Coquille bureau absente.'))
    return internals.invoke(cmd, args)
  }
  return {
    listen: async () => Number(await invoke('oauth_listen')),
    open: async url => { await invoke('open_external', { url }) },
    wait: async timeoutSecs => String(await invoke('oauth_wait', { timeoutSecs })),
  }
}

/** Un echec de connexion, dit en clair. */
export function describeAuthError(err: unknown): string {
  if (isNetworkError(err)) return 'Impossible de joindre le serveur ou son service de connexion. Vérifiez votre connexion.'
  const code = (err as { code?: unknown } | null)?.code
  if (code === 'access_denied') return 'Connexion annulée.'
  const status = httpStatusOf(err)
  if (status === 503) return 'La connexion n\'est pas configurée sur ce serveur (fournisseur d\'identité).'
  if (status !== null && status >= 500) return `Le serveur a rencontré une erreur (${status}). Réessayez plus tard.`
  const msg = err instanceof Error ? err.message.replace(/^\d{3}\s+/, '') : String(err)
  return `Connexion impossible : ${msg}`
}
