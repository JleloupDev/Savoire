// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Telecharger un vault sur le poste, l'envoyer sur le serveur : ce que l'app
// web branche sur le service VaultTransferService.
//
// La version bureau fournit le disque par un VaultFolderHost (setVaultFolderHost) :
// choisir un dossier, l'ouvrir en session. Sans hote (navigateur), le
// telechargement devient un export .zip, fait dans un dossier en memoire.
import {
  VaultTransferService,
  type DiskVaultSessionOpener, type IVaultSyncSession, type RemoteVaultAccess, type VaultTransferJob,
  type VaultTransferResult,
} from '@savoire/application'
import type { DocumentSyncKind, IVaultFileSystem } from '@savoire/platform'
import type { VaultTransferActions, VaultSummaryLike } from '@savoire/plugin-vault-browser'
import { notify } from '@savoire/notifications'
import { createZip, type ZipEntry } from './zipArchive'

/** Ce que la coquille bureau donne a l'app pour copier un vault vers le disque et retour. */
export interface VaultFolderHost {
  /** Nouveau dossier, vide, pour y telecharger un vault (la personne choisit ou). Null si elle annule. */
  createDownloadFolder(vaultName: string): Promise<IVaultFileSystem | null>
  /** Le dossier d'un vault local (profil bureau : un vault = un dossier). */
  fileSystemOf(vaultId: string): Promise<IVaultFileSystem>
  /** Ouvre la session d'un vault sur un dossier (FileSystemVaultSession). */
  openDiskSession: DiskVaultSessionOpener
  /**
   * Le serveur ou envoyer un vault local : ses sessions, ses vaults, le compte
   * connecte. Rejette si la personne n'est pas connectee. Absent : la version
   * bureau ne sait pas joindre de serveur, l'envoi est masque.
   */
  remote?(): Promise<RemoteVaultAccess>
}

let folderHost: VaultFolderHost | null = null

/** Pose l'hote bureau (appele par l'integration bureau au demarrage). */
export function setVaultFolderHost(host: VaultFolderHost | null): void {
  folderHost = host
}

export function getVaultFolderHost(): VaultFolderHost | null {
  return folderHost
}

/** Un transfert lance, tel que la fenetre de progression l'affiche. */
export interface VaultTransferRun {
  title: string
  job: VaultTransferJob
  /** Message de fin en cas de succes (ou se trouve la copie). */
  doneLabel(result: VaultTransferResult): string
}

export interface VaultTransferContext {
  /** Profil de l'app : 'desktop' = la liste des vaults est celle des dossiers du poste. */
  profile: string
  /** Le serveur, vu du profil de l'app (navigateur, ou bureau en profil serveur). */
  appRemote(): Promise<RemoteVaultAccess>
  /** Session du vault actif, si c'est celui-ci. */
  activeSession(vaultId: string): IVaultSyncSession | undefined
  syncKindOf(path: string): DocumentSyncKind
  /** Session sur un dossier en memoire, pour l'export .zip du navigateur. Absente : export masque. */
  memoryDiskSession?: DiskVaultSessionOpener
  /** Fabrique un dossier en memoire (InMemoryVaultFileSystem). */
  memoryFolder?(name: string): IVaultFileSystem
  /** Ouvre la fenetre de progression. */
  show(run: VaultTransferRun): void
  /** La liste des vaults a change (vault cree par un envoi). */
  refreshVaults(): void
  onError(message: string): void
}

/**
 * Les actions du menu d'un vault, selon l'endroit ou tourne l'app :
 *   - profil bureau (unifie), selon la SOURCE du vault :
 *       vault du serveur -> « Télécharger sur ce poste… » (dossier) ;
 *       vault du poste   -> « Envoyer sur le serveur… » ;
 *   - vaults du serveur + bureau en profil serveur : « Télécharger sur ce poste… » ;
 *   - vaults du serveur + navigateur  : « Exporter en .zip ».
 */
export function vaultTransferActions<TVault extends VaultSummaryLike>(ctx: VaultTransferContext): VaultTransferActions<TVault> | null {
  const host = folderHost
  const transferOptions = () => ({ syncKindOf: ctx.syncKindOf })
  const start = (run: VaultTransferRun): void => {
    announceTransfer(run)
    ctx.show(run)
  }

  if (ctx.profile === 'desktop') {
    if (!host?.remote) return null
    const remote = host.remote.bind(host)
    const isServerVault = (vault: TVault): boolean => vault.source === 'server'
    return {
      download: {
        label: 'Télécharger sur ce poste…',
        appliesTo: isServerVault,
        run: (vault) => void (async () => {
          const fs = await host.createDownloadFolder(vault.name)
          if (!fs) return
          const service = new VaultTransferService({ remote, activeSession: ctx.activeSession, openDiskSession: host.openDiskSession, transferOptions })
          const job = service.downloadVault(vault.id, fs)
          // La copie est un nouveau dossier : elle apparait dans « Sur cet ordinateur ».
          void job.result.then(() => ctx.refreshVaults(), () => {})
          start({ title: `Téléchargement de « ${vault.name} »`, job, doneLabel: () => `Copie dans ${fs.rootLabel}.` })
        })().catch(err => ctx.onError(errorText(err))),
      },
      upload: {
        label: 'Envoyer sur le serveur…',
        appliesTo: (vault) => !isServerVault(vault),
        run: (vault) => void (async () => {
          // Le vault actif : sa session sert de source (pas deux sessions sur un dossier).
          const source = ctx.activeSession(vault.id) ?? await host.fileSystemOf(vault.id)
          const service = new VaultTransferService({ remote, openDiskSession: host.openDiskSession, transferOptions })
          const job = service.uploadVault(source, vault.name, vault.id)
          void job.result.then(() => ctx.refreshVaults(), () => {})
          start({ title: `Envoi de « ${vault.name} » sur le serveur`, job, doneLabel: () => 'Nouveau vault créé sur le serveur.' })
        })().catch(err => ctx.onError(errorText(err))),
      },
    }
  }

  const remote = ctx.appRemote
  const activeSession = ctx.activeSession
  if (host) {
    return {
      download: {
        label: 'Télécharger sur ce poste…',
        run: (vault) => void (async () => {
          const fs = await host.createDownloadFolder(vault.name)
          if (!fs) return
          const service = new VaultTransferService({ remote, activeSession, openDiskSession: host.openDiskSession, transferOptions })
          start({ title: `Téléchargement de « ${vault.name} »`, job: service.downloadVault(vault.id, fs), doneLabel: () => `Copie dans ${fs.rootLabel}.` })
        })().catch(err => ctx.onError(errorText(err))),
      },
    }
  }

  const memorySession = ctx.memoryDiskSession
  const memoryFolder = ctx.memoryFolder
  if (!memorySession || !memoryFolder) return null
  return {
    download: {
      label: 'Exporter en .zip',
      run: (vault) => {
        const fs = memoryFolder(vault.name)
        const service = new VaultTransferService({ remote, activeSession, openDiskSession: memorySession, transferOptions })
        const job = service.downloadVault(vault.id, fs)
        const fileName = `${safeFileName(vault.name)}.zip`
        void job.result.then(async (result) => {
          if (result.cancelled) return
          saveBlob(await zipFolder(fs), fileName)
        }, () => {})
        start({ title: `Export de « ${vault.name} »`, job, doneLabel: () => `Archive ${fileName} enregistrée.` })
      },
    },
  }
}

/** Une phrase de resume : copies, deja presents, dossiers, erreurs. */
export function summarize(result: VaultTransferResult): string {
  const plural = (n: number, word: string): string => `${n} ${word}${n > 1 ? 's' : ''}`
  const parts = [`${plural(result.copied, 'document')} copié${result.copied > 1 ? 's' : ''}`]
  if (result.skipped) parts.push(plural(result.skipped, 'déjà présent'))
  if (result.folders) parts.push(plural(result.folders, 'dossier'))
  if (result.errors.length) parts.push(plural(result.errors.length, 'erreur'))
  return parts.join(', ')
}

/** Notification de fin, que la fenetre de progression soit encore ouverte ou non. */
export function announceTransfer(run: VaultTransferRun): void {
  run.job.result.then(
    r => {
      if (r.cancelled) notify('warn', `${run.title} : annulé`, summarize(r))
      else if (r.errors.length) notify('warn', `${run.title} : terminé avec des erreurs`, summarize(r))
      else notify('success', `${run.title} : terminé`, `${summarize(r)}. ${run.doneLabel(r)}`)
    },
    err => notify('danger', `${run.title} : échec`, errorText(err)),
  )
}

/** Tout le dossier (notes, images, `.savoire/`) dans une archive. */
export async function zipFolder(fs: IVaultFileSystem): Promise<Blob> {
  const entries: ZipEntry[] = []
  const all = await fs.list('', { recursive: true })
  for (const entry of all.sort((a, b) => a.path.localeCompare(b.path))) {
    if (entry.kind === 'directory') {
      // Un dossier n'a besoin d'une entree que s'il est vide.
      if (!all.some(e => e.path.startsWith(`${entry.path}/`))) entries.push({ path: `${entry.path}/` })
      continue
    }
    entries.push({
      path: entry.path,
      bytes: await fs.readBytes(entry.path),
      date: entry.mtimeMs ? new Date(entry.mtimeMs) : undefined,
    })
  }
  return createZip(entries)
}

function saveBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = fileName
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

function safeFileName(name: string): string {
  return name.replace(/[\\/:*?"<>|]+/g, ' ').trim() || 'vault'
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
