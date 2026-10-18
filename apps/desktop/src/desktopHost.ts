// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// L'hote bureau : ce que la version bureau offre a l'application web en plus
// du navigateur. Choisir un dossier, en creer un, retrouver les vaults
// recents, et ouvrir le systeme de fichiers d'un vault.
//
// Point d'accroche pour le transfert serveur <-> disque : pickVaultFolder()
// rend directement le systeme de fichiers du dossier choisi.

import type { IVaultFileSystem } from '@savoire/platform'
import type { TauriBridge } from './bridge'
import { TauriVaultFileSystem } from './TauriVaultFileSystem'
import { sortRecent, type RecentVault } from './recentVaults'

/** Un dossier de vault ouvert : ses infos et son systeme de fichiers. */
export interface OpenedVaultFolder {
  vault: RecentVault
  fs: IVaultFileSystem
}

export interface DesktopHost {
  /** « Ouvrir un dossier… » : boite de dialogue native. Null si la personne annule. */
  pickVaultFolder(): Promise<OpenedVaultFolder | null>
  /** « Nouveau vault… » : la personne choisit ou ; le dossier prend ce nom. */
  createVaultFolder(name: string): Promise<OpenedVaultFolder | null>
  /** Vaults ouverts recemment, les plus recents d'abord. */
  listRecent(): Promise<RecentVault[]>
  /** Rouvre un vault de la liste (refuse un chemin jamais choisi). */
  openRecent(path: string): Promise<OpenedVaultFolder>
  /** Retire de la liste. Le dossier n'est jamais touche. */
  forgetRecent(path: string): Promise<void>
  /** Nom affiche dans la liste. Le dossier garde son nom. */
  renameRecent(path: string, name: string): Promise<void>
}

export function createDesktopHost(bridge: TauriBridge): DesktopHost {
  const opened = (vault: RecentVault): OpenedVaultFolder => ({
    vault,
    fs: new TauriVaultFileSystem(bridge, vault.path, vault.path),
  })
  return {
    async pickVaultFolder() {
      const vault = await bridge.invoke<RecentVault | null>('vault_pick_folder')
      return vault ? opened(vault) : null
    },
    async createVaultFolder(name) {
      const vault = await bridge.invoke<RecentVault | null>('vault_create_folder', { name })
      return vault ? opened(vault) : null
    },
    async listRecent() {
      return sortRecent(await bridge.invoke<RecentVault[]>('vault_recent_list'))
    },
    async openRecent(path) {
      return opened(await bridge.invoke<RecentVault>('vault_recent_open', { path }))
    },
    forgetRecent: (path) => bridge.invoke('vault_recent_forget', { path }),
    renameRecent: (path, name) => bridge.invoke('vault_recent_rename', { path, name }),
  }
}
