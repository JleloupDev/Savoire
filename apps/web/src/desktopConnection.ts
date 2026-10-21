// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Version bureau : se connecter a un serveur Savoire, a tout moment, sans
// quitter le vault ouvert. Un seul compte a la fois : se connecter (meme
// serveur ou autre) remplace le compte precedent, dont la session est
// revoquee sur son serveur et effacee du poste.
//
// Le deroule est ici, sans React, pour etre teste ; la fenetre du bouton
// serveur (DesktopServerDialog.tsx) ne fait que l'appeler.

import { HttpAuthBackend, normalizeServerAddress } from '@savoire/infrastructure-sync'
import { chooseServer, clearServerSession, forgetServer, getServerChoice } from './serverConnection'
import { classifyLoginError } from './serverErrors'
import type { AccountEntry } from './types'

/** Le compte connecte avant l'operation (jeton d'acces compris), s'il y en a un. */
export interface CurrentServerAccount {
  server: string | null
  account: AccountEntry | null
  token: string | null
}

export interface DesktopConnectionDeps {
  current(): CurrentServerAccount
  /** Choisit le serveur (adresse saisie, normalisee) ; rend l'adresse retenue. */
  chooseServer(input: string): Promise<string>
  /** Adresses deja connues (pour ne pas garder une adresse neuve qui ne mene nulle part). */
  knownServers(): string[]
  /** Connexion du compte sur le serveur choisi (AuthContext.login, un seul compte). */
  login(email: string, password: string): Promise<void>
  /** Revoque une session sur un serveur donne (meilleur effort). */
  revoke(server: string, accessToken: string, refreshToken: string): Promise<void>
  /** Efface la session gardee d'un serveur. */
  clearSession(server: string): Promise<void>
  /** Oublie une adresse de la liste. */
  forget(server: string): Promise<void>
}

/** Branchement reel : serverConnection.ts et le client HTTP d'authentification. */
export function desktopConnectionDeps(auth: {
  current(): CurrentServerAccount
  login(email: string, password: string): Promise<void>
}): DesktopConnectionDeps {
  return {
    current: auth.current,
    login: auth.login,
    chooseServer,
    knownServers: () => getServerChoice().servers,
    revoke: (server, accessToken, refreshToken) => new HttpAuthBackend(server).logout(accessToken, refreshToken),
    clearSession: clearServerSession,
    forget: forgetServer,
  }
}

/**
 * Se connecter a `serverInput` avec ce compte. Rend l'adresse retenue.
 * En cas d'echec, rien ne change : le serveur et le compte d'avant restent.
 * Rejette avec l'erreur d'origine (a dire en clair avec describeLoginError).
 */
export async function connectToServer(
  deps: DesktopConnectionDeps,
  serverInput: string,
  email: string,
  password: string,
): Promise<string> {
  const before = deps.current()
  // Rejette une adresse invalide (ServerAddressError) avant de rien toucher.
  const wanted = normalizeServerAddress(serverInput)
  const isNew = !deps.knownServers().includes(wanted)
  const url = await deps.chooseServer(wanted)
  try {
    await deps.login(email.trim(), password)
  } catch (err) {
    // Retour au serveur d'avant : son compte, s'il y en avait un, reste connecte.
    if (before.server && before.server !== url) await deps.chooseServer(before.server).catch(() => {})
    // Une adresse neuve qui ne mene a aucun serveur Savoire n'est pas gardee.
    const kind = classifyLoginError(err)
    if (isNew && (kind === 'unreachable' || kind === 'not-savoire')) await deps.forget(url).catch(() => {})
    throw err
  }
  // Le compte precedent est remplace : sa session ne doit plus servir.
  if (before.account && before.server) {
    if (before.token) {
      void deps.revoke(before.server, before.token, before.account.refreshToken).catch(() => {})
    }
    if (before.server !== url) await deps.clearSession(before.server).catch(() => {})
  }
  return url
}

/** Ce que montre le bouton serveur. */
export interface ServerStatus {
  /** 'connected' : jeton valide ; 'offline' : compte garde, serveur injoignable ; 'none' : personne. */
  state: 'connected' | 'offline' | 'none'
  server: string | null
  account: AccountEntry | null
  /** Texte court du bouton. */
  label: string
}

/** Hote (et port) d'une adresse, pour un libelle court : « savoire.exemple.fr ». */
export function serverLabel(server: string | null): string {
  if (!server) return 'Serveur'
  try {
    const u = new URL(server)
    return u.host + (u.pathname && u.pathname !== '/' ? u.pathname : '')
  } catch {
    return server
  }
}

export function serverStatus(server: string | null, account: AccountEntry | null, token: string | null): ServerStatus {
  if (account && token) {
    return { state: 'connected', server, account, label: `${serverLabel(server)} · ${account.displayName}` }
  }
  if (account) return { state: 'offline', server, account, label: `Hors ligne · ${serverLabel(server)}` }
  return { state: 'none', server, account: null, label: 'Hors ligne · non connecté' }
}
