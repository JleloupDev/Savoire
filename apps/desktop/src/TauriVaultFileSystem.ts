// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Implementation Tauri du port IVaultFileSystem : chaque appel devient une
// commande Rust (src-tauri/src/vault_fs.rs). La racine est le chemin absolu
// rendu par Rust a l'ouverture du dossier ; Rust refuse toute racine qui n'a
// pas ete choisie par la personne, et tout chemin qui en sortirait.

import type { FileChange, FileEntry, IVaultFileSystem } from '@savoire/platform'
import type { TauriBridge } from './bridge'

/** Evenement emis par src-tauri/src/watch.rs. */
export const FS_CHANGE_EVENT = 'vault-fs-change'

interface FsChangePayload {
  watchId: number
  changes: FileChange[]
}

export class TauriVaultFileSystem implements IVaultFileSystem {
  constructor(
    private readonly bridge: TauriBridge,
    /** Chemin absolu canonique de la racine (identifiant cote Rust). */
    readonly root: string,
    readonly rootLabel: string = root,
  ) {}

  private call<T>(cmd: string, args: Record<string, unknown>): Promise<T> {
    return this.bridge.invoke<T>(cmd, { root: this.root, ...args })
  }

  readText(path: string): Promise<string> {
    return this.call('vault_read_text', { path })
  }

  async readBytes(path: string): Promise<Uint8Array> {
    const raw = await this.call<ArrayBuffer | Uint8Array | number[]>('vault_read_bytes', { path })
    return raw instanceof Uint8Array ? raw : new Uint8Array(raw as ArrayBuffer)
  }

  writeText(path: string, content: string): Promise<void> {
    return this.call('vault_write_text', { path, content })
  }

  writeBytes(path: string, content: Uint8Array): Promise<void> {
    // Octets bruts dans le corps ; racine et chemin en en-tetes, encodes
    // (un en-tete HTTP ne porte que de l'ASCII).
    return this.bridge.invoke('vault_write_bytes', content, {
      headers: {
        'x-vault-root': encodeURIComponent(this.root),
        'x-vault-path': encodeURIComponent(path),
      },
    })
  }

  exists(path: string): Promise<boolean> {
    return this.call('vault_exists', { path })
  }

  stat(path: string): Promise<FileEntry | null> {
    return this.call('vault_stat', { path })
  }

  list(dir: string, options?: { recursive?: boolean }): Promise<FileEntry[]> {
    return this.call('vault_list', { dir, recursive: options?.recursive ?? false })
  }

  mkdir(path: string): Promise<void> {
    return this.call('vault_mkdir', { path })
  }

  rename(from: string, to: string): Promise<void> {
    return this.call('vault_rename', { from, to })
  }

  remove(path: string): Promise<void> {
    return this.call('vault_remove', { path })
  }

  watch(cb: (changes: FileChange[]) => void): () => void {
    // watch() est synchrone, l'abonnement ne l'est pas : on garde de quoi
    // tout defaire meme si l'arret arrive avant la fin de l'abonnement.
    let stopped = false
    let watchId: number | null = null
    let unlisten: (() => void) | null = null

    void (async () => {
      try {
        // On ecoute AVANT de demander la surveillance : aucun evenement perdu.
        unlisten = await this.bridge.listen<FsChangePayload>(FS_CHANGE_EVENT, (payload) => {
          // Tant que l'identifiant n'est pas connu, rien n'est a nous : la
          // session relit l'etat du disque a l'ouverture de toute facon.
          if (stopped || watchId === null) return
          if (payload.watchId === watchId && payload.changes.length > 0) cb(payload.changes)
        })
        if (stopped) { unlisten(); return }
        watchId = await this.call<number>('vault_watch', {})
        if (stopped) void this.bridge.invoke('vault_unwatch', { watchId })
      } catch (err) {
        console.error('[desktop] surveillance du disque impossible', err)
      }
    })()

    return () => {
      if (stopped) return
      stopped = true
      unlisten?.()
      if (watchId !== null) void this.bridge.invoke('vault_unwatch', { watchId })
    }
  }
}
