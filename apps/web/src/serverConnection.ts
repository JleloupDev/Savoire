// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Le serveur Savoire auquel l'app parle.
//
// Navigateur : la page vient du serveur, rien a choisir, URL relatives.
// Version bureau : la personne saisit l'adresse a la connexion. On garde
// les adresses connues et le serveur choisi, et pour chaque serveur sa
// session (comptes connectes), cote Rust (voir @savoire/desktop
// serverSettings.ts). Le serveur choisi devient la base de toutes les URL du
// client (setServerBaseUrl, dans @savoire/infrastructure-sync).
//
// Ce fichier reste dans le bundle web : il ne charge pas Tauri, il recoit
// l'acces aux reglages par installDesktopServers().

import { normalizeServerAddress, setServerBaseUrl } from '@savoire/infrastructure-sync'
import { parseAccounts, persistedAccounts, setAccountStorage } from './accountStorage'
import type { AccountEntry } from './types'

/** Ce que la version bureau fournit (voir @savoire/desktop DesktopServerSettings). */
export interface ServerSettingsPort {
  list(): Promise<{ servers: string[]; current: string | null }>
  select(url: string): Promise<{ servers: string[]; current: string | null }>
  forget(url: string): Promise<{ servers: string[]; current: string | null }>
  loadSession(url: string): Promise<string | null>
  saveSession(url: string, data: string | null): Promise<void>
}

export interface ServerChoice {
  /** La personne choisit-elle son serveur (version bureau) ? Non dans le navigateur. */
  configurable: boolean
  /** Adresses proposees, la plus recente d'abord. */
  servers: string[]
  /** Le serveur des URL du client ; null : aucun choisi (bureau, premier lancement). */
  current: string | null
}

let settings: ServerSettingsPort | null = null
let choice: ServerChoice = { configurable: false, servers: [], current: null }
let defaultServer: string | null = null
const listeners = new Set<(c: ServerChoice) => void>()

export function getServerChoice(): ServerChoice {
  return choice
}

export function subscribeServerChoice(cb: (c: ServerChoice) => void): () => void {
  listeners.add(cb)
  return () => { listeners.delete(cb) }
}

function publish(next: ServerChoice): void {
  choice = next
  for (const cb of listeners) cb(next)
}

/**
 * Serveur du paquet installe, par defaut : le backend sur CE poste, port
 * 5000. Le serveur n'est pas expose publiquement : on y accede par un
 * tunnel SSH (ssh -L 5000:localhost:5000 <machine>), donc une adresse
 * locale, inaccessible a qui n'a pas ce tunnel.
 */
export const PACKAGED_DEFAULT_SERVER = 'http://127.0.0.1:5000'

/**
 * Serveur par defaut de la version bureau : en developpement, la page vient
 * du Vite (http://127.0.0.1:3002), dont le proxy mene au backend. Dans le
 * paquet installe (tauri://localhost, http://tauri.localhost) : le backend
 * local, joint par tunnel SSH.
 */
export function defaultServerFor(location: { protocol: string; hostname: string; origin: string }): string | null {
  if (location.protocol !== 'http:' && location.protocol !== 'https:') return PACKAGED_DEFAULT_SERVER
  if (location.hostname === 'tauri.localhost') return PACKAGED_DEFAULT_SERVER
  return location.origin
}

function withDefault(servers: string[]): string[] {
  return defaultServer && !servers.includes(defaultServer) ? [...servers, defaultServer] : servers
}

/** Les comptes du serveur `url`, gardes cote Rust a chaque changement. */
async function loadAccountsOf(url: string | null): Promise<void> {
  if (!settings || !url) {
    setAccountStorage(persistedAccounts([], () => {}))
    return
  }
  const port = settings
  let initial: AccountEntry[] = []
  try {
    initial = parseAccounts(await port.loadSession(url))
  } catch (err) {
    console.error('[server] session gardee illisible', err)
  }
  setAccountStorage(persistedAccounts(initial, (accounts) => {
    port.saveSession(url, accounts.length ? JSON.stringify(accounts) : null)
      .catch(err => console.error('[server] session non gardee', err))
  }))
}

/**
 * Version bureau, au demarrage (avant le premier rendu) : lit les serveurs
 * connus, pose la base des URL et les comptes du serveur choisi.
 */
export async function installDesktopServers(
  port: ServerSettingsPort,
  location: { protocol: string; hostname: string; origin: string } = window.location,
): Promise<ServerChoice> {
  settings = port
  defaultServer = defaultServerFor(location)
  let list: { servers: string[]; current: string | null } = { servers: [], current: null }
  try {
    list = await port.list()
  } catch (err) {
    console.error('[server] liste des serveurs illisible', err)
  }
  const current = list.current ?? defaultServer
  setServerBaseUrl(current ?? '')
  await loadAccountsOf(current)
  publish({ configurable: true, servers: withDefault(list.servers), current })
  return choice
}

/**
 * La personne choisit un serveur (saisie libre, normalisee ici). Rend
 * l'adresse retenue. Changer de serveur change aussi les comptes : ceux du
 * nouveau serveur, s'il en a de gardes. Rejette avec un message lisible.
 */
export async function chooseServer(input: string): Promise<string> {
  const url = normalizeServerAddress(input)
  if (!settings) throw new Error('Le serveur ne se choisit que dans l\'application de bureau.')
  if (url === choice.current) {
    // Deja choisi : on le remonte seulement en tete de liste.
    const list = await settings.select(url)
    publish({ ...choice, servers: withDefault(list.servers) })
    return url
  }
  const list = await settings.select(url)
  setServerBaseUrl(url)
  await loadAccountsOf(url)
  publish({ configurable: true, servers: withDefault(list.servers), current: url })
  return url
}

/** Oublie un serveur de la liste, et sa session. */
export async function forgetServer(url: string): Promise<void> {
  if (!settings) return
  const list = await settings.forget(url)
  const current = choice.current === url ? (list.current ?? null) : choice.current
  if (current !== choice.current) {
    setServerBaseUrl(current ?? '')
    await loadAccountsOf(current)
  }
  publish({ configurable: true, servers: withDefault(list.servers.filter(s => s !== url)), current })
}
