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
//
// Profil UNIFIE : si la personne se connecte a un serveur Savoire (bouton
// serveur, a tout moment), les vaults de son compte s'ajoutent a la liste, a
// cote des dossiers, et s'ouvrent dans la meme session de l'app, sans
// rechargement. La liste (UnifiedVaultsBackend) et la fabrique de sessions
// (UnifiedVaultSessionFactory) routent selon l'identifiant du vault :
// `disk:<chemin>` = un dossier, sinon un vault du serveur. La connexion n'est
// jamais requise.

import type {
  AppVaultSummary, AppWorkspace, IVaultSyncSession, IVaultSyncSessionFactory, IVaultsBackend,
  VaultSyncSessionFactoryParams,
} from '@savoire/application'
import {
  FileSystemVaultSession, HttpVaultsBackend, LocalKeyProvider, ServerKeyProvider, getServerBaseUrl,
} from '@savoire/infrastructure-sync'
import type { IVaultFileSystem } from '@savoire/platform'
import type { IIdentityProvider, ISeedExportingIdentityProvider } from '@savoire/plugin-api'
import {
  createDesktopHost, createServerSettings, loadTauriBridge, pathForVaultId, vaultIdForPath,
  type DesktopHost, type DesktopServerSettings, type OpenedVaultFolder, type RecentVault,
} from '@savoire/desktop'
import { LOCAL_VAULT_ROLE, MISSING_VAULT_ROLE } from './desktopAccount'
import { setVaultFolderHost } from './vaultTransfer'
import { makeServerVaultAccess, makeServerVaultSessionFactory } from './createWebAppRoot'

/** Le compte connecte au serveur Savoire (un seul a la fois), ou null. */
export type ServerAuth = { token: string; userId: string }
export type GetServerAuth = () => ServerAuth | null

/** D'ou vient un vault : un dossier de la machine, ou le compte du serveur. */
export type DesktopVaultSource = 'local' | 'server'

/** `disk:<chemin>` = un dossier ; tout autre identifiant = un vault du serveur. */
export function sourceOfVault(vaultId: string): DesktopVaultSource {
  return pathForVaultId(vaultId) !== null ? 'local' : 'server'
}

/** Personne n'est connecte : les vaults du serveur sont inaccessibles. */
export class ServerNotConnectedError extends Error {
  constructor() {
    super('Connectez-vous au serveur Savoire pour ouvrir ce vault.')
    this.name = 'ServerNotConnectedError'
  }
}

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

/**
 * Liste unifiee : les dossiers de la machine, puis les vaults du compte
 * serveur s'il y en a un de connecte. Les arguments userId/token de l'appel
 * sont ignores : le local n'en a pas besoin, le serveur prend le compte
 * connecte (getServerAuth). Un serveur injoignable ne vide pas la liste : les
 * dossiers restent, l'erreur se lit dans serverError().
 */
export class UnifiedVaultsBackend implements IVaultsBackend {
  private lastServerError: unknown = null

  constructor(
    private readonly local: IVaultsBackend,
    private readonly server: IVaultsBackend,
    private readonly getServerAuth: GetServerAuth,
  ) {}

  /** Erreur du dernier appel de liste au serveur (null : tout va bien, ou pas connecte). */
  serverError(): unknown {
    return this.lastServerError
  }

  async listVaults(userId: string, token: string): Promise<AppWorkspace> {
    const auth = this.getServerAuth()
    const [local, remote] = await Promise.all([
      this.local.listVaults(userId, token),
      auth
        ? this.server.listVaults(auth.userId, auth.token).then(
          (w) => { this.lastServerError = null; return w },
          (err: unknown) => { this.lastServerError = err; return null },
        )
        : Promise.resolve(null),
    ])
    if (!auth) this.lastServerError = null
    return {
      vaults: [...local.vaults, ...(remote?.vaults ?? [])],
      sharedWithMe: remote?.sharedWithMe ?? [],
    }
  }

  /** Sans precision, « nouveau vault » = un dossier (le port n'a pas de source). */
  createVault(userId: string, name: string, token: string): Promise<AppVaultSummary> {
    return this.local.createVault(userId, name, token)
  }

  /** Nouveau vault, la ou la personne l'a demande. */
  async createVaultOn(source: DesktopVaultSource, name: string): Promise<AppVaultSummary> {
    if (source === 'local') return this.local.createVault('local', name, '')
    const auth = this.requireAuth()
    return this.server.createVault(auth.userId, name, auth.token)
  }

  async renameVault(vaultId: string, name: string, token: string): Promise<AppVaultSummary> {
    if (sourceOfVault(vaultId) === 'local') return this.local.renameVault(vaultId, name, token)
    return this.server.renameVault(vaultId, name, this.requireAuth().token)
  }

  async deleteVault(vaultId: string, token: string): Promise<void> {
    if (sourceOfVault(vaultId) === 'local') return this.local.deleteVault(vaultId, token)
    return this.server.deleteVault(vaultId, this.requireAuth().token)
  }

  private requireAuth(): ServerAuth {
    const auth = this.getServerAuth()
    if (!auth) throw new ServerNotConnectedError()
    return auth
  }
}

/** Identite de signature du compte serveur (cle servie par le serveur). */
export type ServerIdentityOf = (auth: ServerAuth) => Promise<ISeedExportingIdentityProvider>

/**
 * Une identite par compte et par serveur : la cle d'un compte ne sert
 * jamais a signer pour un autre (un ServerKeyProvider garde la premiere cle
 * qu'il a recue).
 */
export function serverIdentityCache(getServerAuth: GetServerAuth): ServerIdentityOf {
  const byAccount = new Map<string, ServerKeyProvider>()
  return async (auth) => {
    const key = `${getServerBaseUrl()}|${auth.userId}`
    let provider = byAccount.get(key)
    if (!provider) {
      provider = new ServerKeyProvider({ getToken: () => getServerAuth()?.token ?? null })
      byAccount.set(key, provider)
    }
    await provider.init()
    return provider
  }
}

/**
 * Fabrique de sessions unifiee : un dossier -> session sur disque ; un vault
 * du serveur -> session serveur, avec le jeton, le compte et l'identite du
 * compte connecte (le compte de l'app reste le compte local).
 */
export class UnifiedVaultSessionFactory implements IVaultSyncSessionFactory {
  constructor(
    private readonly disk: IVaultSyncSessionFactory,
    private readonly server: IVaultSyncSessionFactory,
    private readonly getServerAuth: GetServerAuth,
    private readonly identityOf: ServerIdentityOf,
  ) {}

  async open(params: VaultSyncSessionFactoryParams): Promise<IVaultSyncSession> {
    if (sourceOfVault(params.vaultId) === 'local') return this.disk.open(params)
    const auth = this.getServerAuth()
    if (!auth) throw new ServerNotConnectedError()
    const identity = await this.identityOf(auth)
    return this.server.open({
      ...params,
      token: auth.token,
      userId: auth.userId,
      identity,
      identitySeed: identity.exportSignSeed?.() ?? params.identitySeed,
    })
  }
}

/** La session d'un vault sur son dossier (format Obsidian + `.savoire/`). */
const openOnDiskDefault: DiskSessionOpener = (fs, params) => FileSystemVaultSession.open(fs, params)

/** Ce que le profil bureau donne a l'application (voir profile.ts). */
export interface DesktopProfileParts {
  host: DesktopHost
  opened: OpenedFolders
  /** Liste unifiee : dossiers + vaults du compte serveur. */
  vaultsBackend: UnifiedVaultsBackend
  vaultSyncSessionFactory: IVaultSyncSessionFactory
  identityProvider: IIdentityProvider
  openOnDisk: DiskSessionOpener
  /** Serveurs Savoire connus et leurs sessions (voir serverConnection.ts). */
  serverSettings: DesktopServerSettings
}

export interface DesktopProfileOptions {
  openOnDisk?: DiskSessionOpener
  /** Le compte connecte au serveur, lu a chaque appel (absent : jamais connecte). */
  getServerAuth?: GetServerAuth
  /** Coupure / retour du reseau d'une session serveur. */
  onConnectionChange?: (state: 'connected' | 'disconnected') => void
}

let loaded: Promise<DesktopProfileParts> | null = null

/**
 * Une seule instance par fenetre : le profil bureau et l'hote de transfert la
 * partagent. Les options du PREMIER appel comptent.
 */
export function loadDesktopProfile(options: DesktopProfileOptions = {}): Promise<DesktopProfileParts> {
  const openOnDisk = options.openOnDisk ?? openOnDiskDefault
  const getServerAuth: GetServerAuth = options.getServerAuth ?? (() => null)
  loaded ??= (async () => {
    const bridge = await loadTauriBridge()
    const host = createDesktopHost(bridge)
    const opened = new OpenedFolders(host)
    const serverToken = () => getServerAuth()?.token ?? null
    return {
      host,
      opened,
      vaultsBackend: new UnifiedVaultsBackend(new DesktopVaultsBackend(host, opened), new HttpVaultsBackend(), getServerAuth),
      vaultSyncSessionFactory: new UnifiedVaultSessionFactory(
        new DesktopVaultSessionFactory(opened, openOnDisk),
        makeServerVaultSessionFactory(serverToken, options.onConnectionChange),
        getServerAuth,
        serverIdentityCache(getServerAuth),
      ),
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
