// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Composition root du profil BUREAU (application dans la fenetre Tauri).
//
// Charge uniquement par profile.ts, par import dynamique, quand l'app tourne
// dans Tauri : ni ce fichier ni @savoire/desktop n'entrent dans le bundle du
// navigateur.
//
// Ce que le profil change, et rien d'autre :
// - la liste des vaults = les dossiers ouverts recemment sur cette machine ;
// - la session d'un vault = ses fichiers sur le disque (FileSystemVaultSession) ;
// - pas de compte necessaire : identite gardee sur la machine, compte local.
// La connexion a un serveur reste possible (transfert serveur <-> disque),
// elle n'est jamais requise.

import type {
  AppVaultSummary, AppWorkspace, IVaultSyncSession, IVaultSyncSessionFactory, IVaultsBackend,
  VaultSyncSessionFactoryParams,
} from '@savoire/application'
import { FileSystemVaultSession, LocalKeyProvider } from '@savoire/infrastructure-sync'
import type { IVaultFileSystem } from '@savoire/platform'
import type { IIdentityProvider } from '@savoire/plugin-api'
import {
  createDesktopHost, createServerSettings, loadTauriBridge, pathForVaultId, vaultIdForPath,
  type DesktopHost, type DesktopServerSettings, type OpenedVaultFolder, type RecentVault,
} from '@savoire/desktop'
import { LOCAL_VAULT_ROLE, MISSING_VAULT_ROLE } from './desktopAccount'
import { setVaultFolderHost } from './vaultTransfer'
import { makeServerVaultAccess } from './createWebAppRoot'

/** Ouvre la session d'un vault sur son systeme de fichiers. */
export type DiskSessionOpener = (
  fs: IVaultFileSystem,
  params: VaultSyncSessionFactoryParams,
) => Promise<IVaultSyncSession>


/** Dossier d'un vault de la version bureau (null : pas un dossier). */
export const pathOfVault = pathForVaultId

/** La personne a ferme la boite de dialogue : rien a signaler. */
export class FolderPickCancelled extends Error {
  constructor() {
    super('choix du dossier annule')
    this.name = 'FolderPickCancelled'
  }
}

export function toVaultSummary(v: RecentVault): AppVaultSummary {
  return {
    id: vaultIdForPath(v.path),
    name: v.name,
    role: v.exists === false ? MISSING_VAULT_ROLE : LOCAL_VAULT_ROLE,
    documentCount: 0,
    folderCount: 0,
    lastModifiedAt: v.lastOpenedMs ? new Date(v.lastOpenedMs).toISOString() : null,
    sizeBytes: 0,
  }
}

/**
 * Les dossiers ouverts pendant la session de l'application. Un dossier
 * choisi a l'instant n'a pas a etre redemande a Rust a l'ouverture du vault.
 */
export class OpenedFolders {
  private readonly byId = new Map<string, OpenedVaultFolder>()

  constructor(private readonly host: Pick<DesktopHost, 'openRecent'>) {}

  remember(folder: OpenedVaultFolder): AppVaultSummary {
    const summary = toVaultSummary(folder.vault)
    this.byId.set(summary.id, folder)
    return summary
  }

  forget(vaultId: string): void {
    this.byId.delete(vaultId)
  }

  /** Le systeme de fichiers d'un vault, en rouvrant le dossier si besoin. */
  async fileSystemOf(vaultId: string): Promise<IVaultFileSystem> {
    const known = this.byId.get(vaultId)
    if (known) return known.fs
    const path = pathForVaultId(vaultId)
    if (!path) throw new Error(`Ce vault n'est pas un dossier de la machine : ${vaultId}`)
    const folder = await this.host.openRecent(path)
    this.remember(folder)
    return folder.fs
  }
}

/** Liste des vaults de la version bureau : les dossiers recents. Ne detruit rien. */
export class DesktopVaultsBackend implements IVaultsBackend {
  constructor(private readonly host: DesktopHost, private readonly opened: OpenedFolders) {}

  async listVaults(): Promise<AppWorkspace> {
    const recent = await this.host.listRecent()
    return { vaults: recent.map(toVaultSummary), sharedWithMe: [] }
  }

  async createVault(_userId: string, name: string): Promise<AppVaultSummary> {
    const folder = await this.host.createVaultFolder(name)
    if (!folder) throw new FolderPickCancelled()
    return this.opened.remember(folder)
  }

  async renameVault(vaultId: string, name: string): Promise<AppVaultSummary> {
    const path = this.pathOf(vaultId)
    await this.host.renameRecent(path, name)
    const found = (await this.host.listRecent()).find(v => v.path === path)
    return toVaultSummary(found ?? { path, name, lastOpenedMs: 0 })
  }

  /** « Supprimer » un vault local le RETIRE de la liste : le dossier reste intact. */
  async deleteVault(vaultId: string): Promise<void> {
    await this.host.forgetRecent(this.pathOf(vaultId))
    this.opened.forget(vaultId)
  }

  private pathOf(vaultId: string): string {
    const path = pathForVaultId(vaultId)
    if (!path) throw new Error(`Ce vault n'est pas un dossier de la machine : ${vaultId}`)
    return path
  }
}

/** Fabrique de sessions : le vault -> son dossier -> la session sur disque. */
export class DesktopVaultSessionFactory implements IVaultSyncSessionFactory {
  constructor(private readonly opened: OpenedFolders, private readonly openOnDisk: DiskSessionOpener) {}

  async open(params: VaultSyncSessionFactoryParams): Promise<IVaultSyncSession> {
    const fs = await this.opened.fileSystemOf(params.vaultId)
    return this.openOnDisk(fs, params)
  }
}

/** La session d'un vault sur son dossier (format Obsidian + `.savoire/`). */
const openOnDiskDefault: DiskSessionOpener = (fs, params) => FileSystemVaultSession.open(fs, params)

/** Ce que le profil bureau donne a l'application (voir profile.ts). */
export interface DesktopProfileParts {
  host: DesktopHost
  opened: OpenedFolders
  vaultsBackend: IVaultsBackend
  vaultSyncSessionFactory: IVaultSyncSessionFactory
  identityProvider: IIdentityProvider
  openOnDisk: DiskSessionOpener
  /** Serveurs Savoire connus et leurs sessions (voir serverConnection.ts). */
  serverSettings: DesktopServerSettings
}

let loaded: Promise<DesktopProfileParts> | null = null

/** Une seule instance par fenetre : le profil bureau et l'hote de transfert la partagent. */
export function loadDesktopProfile(openOnDisk: DiskSessionOpener = openOnDiskDefault): Promise<DesktopProfileParts> {
  loaded ??= (async () => {
    const bridge = await loadTauriBridge()
    const host = createDesktopHost(bridge)
    const opened = new OpenedFolders(host)
    return {
      host,
      opened,
      vaultsBackend: new DesktopVaultsBackend(host, opened),
      vaultSyncSessionFactory: new DesktopVaultSessionFactory(opened, openOnDisk),
      // Cle d'identite gardee sur la machine (stockage de la fenetre) : signe
      // les modifications sans compte ni serveur.
      identityProvider: new LocalKeyProvider(),
      openOnDisk,
      serverSettings: createServerSettings(bridge),
    }
  })()
  return loaded
}

/**
 * Branche le disque sur le transfert serveur <-> disque (vaultTransfer.ts),
 * quel que soit le profil, des que l'app tourne dans Tauri.
 * `getServerAuth` : le compte connecte au serveur, ou null.
 */
export function installVaultFolderHost(
  parts: DesktopProfileParts,
  getServerAuth: () => { token: string; userId: string } | null,
): void {
  setVaultFolderHost({
    createDownloadFolder: async (name) => {
      const folder = await parts.host.createVaultFolder(name)
      if (!folder) return null
      parts.opened.remember(folder)
      return folder.fs
    },
    fileSystemOf: (vaultId) => parts.opened.fileSystemOf(vaultId),
    openDiskSession: parts.openOnDisk,
    remote: makeServerVaultAccess(getServerAuth),
  })
}
