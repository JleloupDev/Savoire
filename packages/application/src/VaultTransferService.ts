// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Telecharger un vault sur le poste, envoyer un vault du poste. Deux
// operations ponctuelles, pas de synchro continue : le service ouvre les deux
// sessions, lance transferVault, puis les ferme.
//
// Le dossier du poste est un IVaultFileSystem (fourni par la coquille bureau) ;
// la session qui le lit et l'ecrit vient d'une fabrique fournie par l'app
// (FileSystemVaultSession). Le service ne connait ni Tauri ni le format du
// dossier.
import type { IVaultFileSystem } from '@savoire/platform'
import type { IIdentityProvider } from '@savoire/plugin-api'
import type { IVaultsAPI, IVaultSyncSession, IVaultSyncSessionFactory, VaultSyncSessionFactoryParams } from './contracts'
import {
  transferVault,
  type VaultTransferOptions, type VaultTransferProgress, type VaultTransferReport,
} from './VaultTransfer'

/** Le compte connecte, au moment du transfert. */
export interface VaultTransferAuth {
  userId: string
  token: string
  identity?: IIdentityProvider
  identitySeed?: Uint8Array
}

/** Ouvre une session de vault sur un dossier du poste. */
export type DiskVaultSessionOpener = (fs: IVaultFileSystem, params: VaultSyncSessionFactoryParams) => Promise<IVaultSyncSession>

/**
 * Le cote « serveur » du transfert : ses sessions, la creation d'un vault et
 * le compte connecte. Dans le navigateur, c'est le profil de l'app ; dans la
 * version bureau (vaults = dossiers), c'est la connexion au serveur.
 */
export interface RemoteVaultAccess {
  sessions: IVaultSyncSessionFactory
  vaults: Pick<IVaultsAPI, 'create'>
  auth: VaultTransferAuth
}

export interface VaultTransferServiceDeps {
  /** Acces au serveur au moment du transfert. Rejette si la personne n'est pas connectee. */
  remote(): Promise<RemoteVaultAccess>
  openDiskSession: DiskVaultSessionOpener
  /** Session deja ouverte sur ce vault du serveur (le vault actif) : reprise comme source. */
  activeSession?(vaultId: string): IVaultSyncSession | undefined
  /** Options du transfert (types des documents d'apres les plugins...). */
  transferOptions?(): Omit<VaultTransferOptions, 'signal' | 'onProgress'>
}

export interface VaultTransferResult extends VaultTransferReport {
  /** Le vault cible (serveur) ou source (telechargement). */
  vaultId: string
}

/** Un transfert en cours : progression observable, annulation, resultat. */
export interface VaultTransferJob {
  readonly direction: 'download' | 'upload'
  /** Derniere progression connue. */
  readonly progress: VaultTransferProgress
  onProgress(cb: (progress: VaultTransferProgress) => void): () => void
  cancel(): void
  /** Rapport de fin. Rejette si le transfert n'a pas pu commencer (dossier non vide, vault perdu...). */
  readonly result: Promise<VaultTransferResult>
}

function isSession(x: IVaultFileSystem | IVaultSyncSession): x is IVaultSyncSession {
  return typeof (x as Partial<IVaultSyncSession>).openDocument === 'function'
}

/** Nom du dossier de travail de Savoire dans un vault sur disque. */
const SAVOIRE_DIR = '.savoire'

export class VaultTransferService {
  constructor(private readonly deps: VaultTransferServiceDeps) {}

  /**
   * Copie un vault existant dans un dossier du poste. Le dossier doit etre
   * vide, ou deja un vault Savoire (relancer complete la copie sans doublon).
   */
  downloadVault(vaultId: string, target: IVaultFileSystem): VaultTransferJob {
    return this.run('download', async (options) => {
      await assertDownloadTarget(target)
      const remote = await this.deps.remote()
      const reused = this.deps.activeSession?.(vaultId)
      const source = reused ?? await remote.sessions.open(this.params(vaultId, remote.auth))
      try {
        const disk = await this.deps.openDiskSession(target, this.params(vaultId, remote.auth))
        try {
          return { vaultId, ...(await transferVault(source, disk, options)) }
        } finally {
          await disk.dispose()
        }
      } finally {
        if (!reused) await source.dispose()
      }
    })
  }

  /**
   * Envoie un vault du poste dans un NOUVEAU vault du serveur, au nom du
   * compte connecte. `source` : le dossier, ou la session deja ouverte dessus
   * (le vault actif de la version bureau : pas deux sessions sur un dossier).
   * `sourceVaultId` : l'id du vault local, s'il est connu (sinon le nom du dossier).
   */
  uploadVault(source: IVaultFileSystem | IVaultSyncSession, name: string, sourceVaultId?: string): VaultTransferJob {
    return this.run('upload', async (options) => {
      const remote = await this.deps.remote()
      // Le dossier d'abord : s'il ne s'ouvre pas, aucun vault n'est cree.
      const opened = isSession(source)
        ? null
        : await this.deps.openDiskSession(source, this.params(sourceVaultId ?? source.rootLabel, remote.auth))
      const disk = opened ?? (source as IVaultSyncSession)
      try {
        const created = await remote.vaults.create(remote.auth.userId, name, remote.auth.token)
        const target = await remote.sessions.open(this.params(created.id, remote.auth))
        try {
          return { vaultId: created.id, ...(await transferVault(disk, target, options)) }
        } finally {
          await target.dispose()
        }
      } finally {
        await opened?.dispose()
      }
    })
  }

  private params(vaultId: string, auth: VaultTransferAuth): VaultSyncSessionFactoryParams {
    return {
      vaultId,
      token: auth.token,
      userId: auth.userId,
      identity: auth.identity,
      identitySeed: auth.identitySeed,
      onChanged: () => {},
    }
  }

  private run(
    direction: 'download' | 'upload',
    body: (options: VaultTransferOptions) => Promise<VaultTransferResult>,
  ): VaultTransferJob {
    const controller = new AbortController()
    const listeners = new Set<(p: VaultTransferProgress) => void>()
    let last: VaultTransferProgress = { phase: 'preparing', done: 0, total: 0, bytes: 0 }
    const options: VaultTransferOptions = {
      ...this.deps.transferOptions?.(),
      signal: controller.signal,
      onProgress: (p) => {
        last = p
        for (const cb of listeners) cb(p)
      },
    }
    // Lance au tour suivant : l'appelant a le temps de s'abonner.
    const result = Promise.resolve().then(() => body(options))
    return {
      direction,
      get progress() { return last },
      onProgress(cb) { listeners.add(cb); return () => { listeners.delete(cb) } },
      cancel: () => controller.abort(),
      result,
    }
  }
}

/** Dossier de telechargement : vide, ou deja un vault Savoire. */
async function assertDownloadTarget(fs: IVaultFileSystem): Promise<void> {
  const entries = await fs.list('')
  if (entries.length === 0) return
  if (entries.some(e => e.kind === 'directory' && e.path === SAVOIRE_DIR)) return
  throw new Error(`Le dossier ${fs.rootLabel} n'est pas vide : choisissez un dossier vide.`)
}
