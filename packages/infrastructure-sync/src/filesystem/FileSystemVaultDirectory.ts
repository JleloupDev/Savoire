// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Repertoire d'un vault sur disque (IVaultDirectory). Le disque est la
// verite : la liste vient des fichiers du dossier. Ce repertoire en garde une
// copie, et il traduit chaque changement de l'application (ajout, renommage,
// suppression, dossier) en une operation sur le disque, confiee a la session.
//
// Meme schema Yjs que YMapVaultDirectory (cartes « vault » et « folders ») :
// encodeFullState() rend un etat que les autres profils savent lire (copie
// d'un vault vers un serveur). Un etat distant applique par applyUpdate() est
// realise sur le disque comme un changement de l'application.
//
// Les changements venus du disque (relecture du dossier) passent par
// applyFromDisk() : ils ne redeclenchent aucune operation sur le disque.
import * as Y from 'yjs'
import type { IDocumentMeta, IVaultDirectory } from '@savoire/platform'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const Y_ = Y as Record<string, any>

const FROM_DISK = 'disk'
const REMOTE = 'remote'

type VaultEntry = { path: string }

/** Ce que le repertoire demande au disque. */
export interface DirectoryDiskOps {
  added(id: string, path: string): void
  renamed(id: string, from: string, to: string): void
  removed(id: string, path: string): void
  folderAdded(path: string): void
  folderRemoved(path: string): void
}

interface MapEvent {
  changes: { keys: Map<string, { action: 'add' | 'update' | 'delete'; oldValue?: unknown }> }
  transaction: { origin: unknown }
}

export class FileSystemVaultDirectory implements IVaultDirectory {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly doc: any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly map: any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly folderMap: any
  private readonly changeCallbacks = new Set<() => void>()
  private disposed = false

  constructor(private readonly disk: DirectoryDiskOps) {
    this.doc = new Y_.Doc()
    this.map = this.doc.getMap('vault')
    this.folderMap = this.doc.getMap('folders')
    this.map.observe((event: MapEvent) => this.onDocsChanged(event))
    this.folderMap.observe((event: MapEvent) => this.onFoldersChanged(event))
    // Un seul signal par transaction, quelle que soit sa taille (relecture du dossier).
    this.doc.on('update', () => { for (const cb of [...this.changeCallbacks]) cb() })
  }

  // ── IVaultDirectory ──────────────────────────────────────────────────────

  getAll(): readonly IDocumentMeta[] {
    if (this.disposed) return []
    const result: IDocumentMeta[] = []
    this.map.forEach((entry: VaultEntry, id: string) => result.push({ id, path: entry.path }))
    return result
  }

  getById(id: string): IDocumentMeta | undefined {
    if (this.disposed) return undefined
    const entry: VaultEntry | undefined = this.map.get(id)
    return entry ? { id, path: entry.path } : undefined
  }

  add(doc: IDocumentMeta): void {
    if (this.disposed) return
    this.map.set(doc.id, { path: doc.path })
  }

  remove(id: string): void {
    if (this.disposed) return
    this.map.delete(id)
  }

  rename(id: string, newPath: string): void {
    if (this.disposed || !this.map.has(id)) return
    this.map.set(id, { path: newPath })
  }

  addFolder(path: string): void {
    if (this.disposed) return
    this.folderMap.set(path, 1)
  }

  removeFolder(path: string): void {
    if (this.disposed) return
    this.folderMap.delete(path)
  }

  getFolders(): readonly string[] {
    if (this.disposed) return []
    const result: string[] = []
    this.folderMap.forEach((_v: unknown, path: string) => result.push(path))
    return result
  }

  encodeFullState(): Uint8Array {
    return Y_.encodeStateAsUpdate(this.doc) as Uint8Array
  }

  /** Etat d'un autre profil : realise sur le disque comme un changement local. */
  applyUpdate(update: Uint8Array): void {
    if (this.disposed) return
    Y_.applyUpdate(this.doc, update, REMOTE)
  }

  onLocalUpdate(cb: (update: Uint8Array) => void): () => void {
    const handler = (update: Uint8Array, origin: unknown): void => {
      if (origin !== REMOTE) cb(update)
    }
    this.doc.on('update', handler)
    return () => this.doc.off('update', handler)
  }

  onChange(cb: () => void): () => void {
    this.changeCallbacks.add(cb)
    return () => { this.changeCallbacks.delete(cb) }
  }

  dispose(): void {
    this.disposed = true
    this.changeCallbacks.clear()
    this.doc.destroy()
  }

  // ── Disque ───────────────────────────────────────────────────────────────

  /** Chemin courant d'un document, ou undefined. */
  pathOf(id: string): string | undefined {
    return this.getById(id)?.path
  }

  /** Id du document a ce chemin, ou undefined. */
  idAt(path: string): string | undefined {
    let found: string | undefined
    this.map.forEach((entry: VaultEntry, id: string) => { if (entry.path === path) found = id })
    return found
  }

  /**
   * Remplace le contenu par ce que montre le disque, en une transaction :
   * documents (id -> chemin) et dossiers. Rien n'est renvoye au disque.
   */
  applyFromDisk(docs: ReadonlyMap<string, string>, folders: ReadonlySet<string>): void {
    if (this.disposed) return
    this.doc.transact(() => {
      this.map.forEach((_e: VaultEntry, id: string) => { if (!docs.has(id)) this.map.delete(id) })
      for (const [id, path] of docs) {
        if ((this.map.get(id) as VaultEntry | undefined)?.path !== path) this.map.set(id, { path })
      }
      this.folderMap.forEach((_v: unknown, f: string) => { if (!folders.has(f)) this.folderMap.delete(f) })
      for (const f of folders) if (!this.folderMap.has(f)) this.folderMap.set(f, 1)
    }, FROM_DISK)
  }

  /** Change un chemin sans operation sur le disque (le disque a deja bouge). */
  setPathFromDisk(id: string, path: string): void {
    if (this.disposed) return
    this.doc.transact(() => this.map.set(id, { path }), FROM_DISK)
  }

  // ── Interne ──────────────────────────────────────────────────────────────

  private onDocsChanged(event: MapEvent): void {
    if (event.transaction.origin === FROM_DISK) return
    for (const [id, change] of event.changes.keys) {
      const old = (change.oldValue as VaultEntry | undefined)?.path
      const now = (this.map.get(id) as VaultEntry | undefined)?.path
      if (change.action === 'add' && now !== undefined) this.disk.added(id, now)
      else if (change.action === 'update' && now !== undefined && old !== undefined && old !== now) this.disk.renamed(id, old, now)
      else if (change.action === 'delete' && old !== undefined) this.disk.removed(id, old)
    }
  }

  private onFoldersChanged(event: MapEvent): void {
    if (event.transaction.origin === FROM_DISK) return
    for (const [path, change] of event.changes.keys) {
      if (change.action === 'add') this.disk.folderAdded(path)
      else if (change.action === 'delete') this.disk.folderRemoved(path)
    }
  }
}
