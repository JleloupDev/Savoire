// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Les mises a jour de l'appli, vues du front (src-tauri/src/updater.rs) :
// chercher, telecharger en fond, redemarrer pour installer. L'adresse de
// l'annonce et la cle de signature restent cote Rust.

import type { TauriBridge } from './bridge'

export interface DesktopUpdate {
  version: string
  currentVersion: string
  notes: string | null
}

export interface DesktopUpdates {
  /** Une version plus recente, ou null (a jour, ou build sans mises a jour). */
  check(): Promise<DesktopUpdate | null>
  /** Telecharge la version trouvee par check(), sans l'installer. */
  download(): Promise<void>
  /** Installe la version telechargee et redemarre l'appli. */
  restart(): Promise<void>
}

export function createDesktopUpdates(bridge: TauriBridge): DesktopUpdates {
  return {
    check: async () => (await bridge.invoke<DesktopUpdate | null>('update_check')) ?? null,
    download: () => bridge.invoke('update_download'),
    restart: () => bridge.invoke('update_restart'),
  }
}
