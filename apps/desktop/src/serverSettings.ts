// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Les serveurs Savoire connus de la version bureau, vus du front. La liste et
// les sessions vivent cote Rust (dossier de configuration de l'application,
// voir src-tauri/src/servers.rs) ; ici on ne fait que les appeler.

import type { TauriBridge } from './bridge'

/** Les adresses connues (la plus recente d'abord) et le serveur choisi. */
export interface ServerList {
  servers: string[]
  current: string | null
}

export interface DesktopServerSettings {
  list(): Promise<ServerList>
  /** Choisit un serveur (adresse deja normalisee) ; l'ajoute s'il est nouveau. */
  select(url: string): Promise<ServerList>
  /** Oublie un serveur et sa session. */
  forget(url: string): Promise<ServerList>
  /** La session gardee pour ce serveur (texte opaque), ou null. */
  loadSession(url: string): Promise<string | null>
  /** Garde la session du serveur ; null l'efface. */
  saveSession(url: string, data: string | null): Promise<void>
}

export function createServerSettings(bridge: TauriBridge): DesktopServerSettings {
  const normalize = (l: ServerList | null | undefined): ServerList => ({
    servers: l?.servers ?? [],
    current: l?.current ?? null,
  })
  return {
    list: async () => normalize(await bridge.invoke<ServerList>('server_list')),
    select: async (url) => normalize(await bridge.invoke<ServerList>('server_select', { url })),
    forget: async (url) => normalize(await bridge.invoke<ServerList>('server_forget', { url })),
    loadSession: async (url) => (await bridge.invoke<string | null>('server_session_get', { url })) ?? null,
    saveSession: (url, data) => bridge.invoke('server_session_set', { url, data }),
  }
}
