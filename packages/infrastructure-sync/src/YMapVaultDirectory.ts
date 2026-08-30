// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import * as Y from 'yjs'
import type { IDocumentMeta, IVaultDirectory } from '@savoire/platform'

// TypeScript 5.9 + moduleResolution:bundler fails to follow Yjs's .js→.d.ts
// re-export chain. Cast once; runtime behaviour is validated by tests.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const Y_ = Y as Record<string, any>

type VaultEntry = { path: string }

// Satisfait structurellement le port ICrdt d'edgesync-protocol (applyUpdate /
// encodeFullState / onLocalUpdate) sans l'importer : le connecteur EdgeSync
// s'en charge. Le cœur reste agnostique au protocole.
export class YMapVaultDirectory implements IVaultDirectory {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly doc: any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly map: any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly folderMap: any
  private readonly changeCallbacks: (() => void)[] = []
  private disposed = false

  constructor() {
    this.doc = new Y_.Doc()
    this.map = this.doc.getMap('vault')
    this.folderMap = this.doc.getMap('folders')
    const notify = (): void => { for (const cb of this.changeCallbacks) cb() }
    this.map.observe(notify)
    this.folderMap.observe(notify)
  }

  getAll(): readonly IDocumentMeta[] {
    if (this.disposed) return []
    const result: IDocumentMeta[] = []
    this.map.forEach((entry: VaultEntry, id: string) => result.push({ id, path: entry.path }))
    return result
  }

  getById(id: string): IDocumentMeta | undefined {
    const entry: VaultEntry | undefined = this.map.get(id)
    return entry ? { id, path: entry.path } : undefined
  }

  add(doc: IDocumentMeta): void {
    this.map.set(doc.id, { path: doc.path })
  }

  remove(id: string): void {
    this.map.delete(id)
  }

  rename(id: string, newPath: string): void {
    if (!this.map.has(id)) return
    this.map.set(id, { path: newPath })
  }

  addFolder(path: string): void {
    this.folderMap.set(path, 1)
  }

  removeFolder(path: string): void {
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

  applyUpdate(update: Uint8Array): void {
    // origin='remote' prevents onLocalUpdate from re-broadcasting applied updates
    Y_.applyUpdate(this.doc, update, 'remote')
  }

  // ── ICrdt (edgesync-protocol) — lets a Session drive this same Y.Doc as its
  // vault-directory channel, alongside the existing IVaultDirectory surface. ──
  snapshot(): Uint8Array {
    return this.encodeFullState()
  }

  applyRemote(update: Uint8Array): void {
    this.applyUpdate(update)
  }

  stateVector(): Uint8Array {
    return Y_.encodeStateVector(this.doc) as Uint8Array
  }

  diffSince(stateVector: Uint8Array): Uint8Array {
    return Y_.encodeStateAsUpdate(this.doc, stateVector) as Uint8Array
  }

  onLocalUpdate(cb: (update: Uint8Array) => void): () => void {
    const handler = (update: Uint8Array, origin: unknown) => {
      if (origin !== 'remote' && origin !== 'server') cb(update)
    }
    this.doc.on('update', handler)
    return () => this.doc.off('update', handler)
  }

  onChange(cb: () => void): () => void {
    this.changeCallbacks.push(cb)
    return () => {
      const idx = this.changeCallbacks.indexOf(cb)
      if (idx !== -1) this.changeCallbacks.splice(idx, 1)
    }
  }

  dispose(): void {
    this.disposed = true
    this.changeCallbacks.length = 0
    this.doc.destroy()
  }
}
