// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import type { IDocumentMeta, IVaultDirectory } from '@savoire/platform'

/**
 * Simple in-memory IVaultDirectory — no CRDT, no Yjs.
 * Use for tests and scenarios that don't need distributed sync.
 * encodeFullState / applyUpdate / onLocalUpdate are no-ops.
 */
export class InMemoryVaultDirectory implements IVaultDirectory {
  private readonly docs = new Map<string, IDocumentMeta>()
  private readonly folders = new Set<string>()
  private readonly changeCallbacks: (() => void)[] = []

  getAll(): readonly IDocumentMeta[] {
    return Array.from(this.docs.values())
  }

  getById(id: string): IDocumentMeta | undefined {
    return this.docs.get(id)
  }

  add(doc: IDocumentMeta): void {
    if (this.docs.has(doc.id)) return
    this.docs.set(doc.id, doc)
    this._notify()
  }

  remove(id: string): void {
    if (this.docs.delete(id)) this._notify()
  }

  rename(id: string, newPath: string): void {
    const doc = this.docs.get(id)
    if (!doc) return
    this.docs.set(id, { ...doc, path: newPath })
    this._notify()
  }

  addFolder(path: string): void {
    if (this.folders.has(path)) return
    this.folders.add(path)
    this._notify()
  }

  removeFolder(path: string): void {
    if (this.folders.delete(path)) this._notify()
  }

  getFolders(): readonly string[] {
    return Array.from(this.folders)
  }

  encodeFullState(): Uint8Array {
    return new Uint8Array(0)
  }

  applyUpdate(_update: Uint8Array): void {}

  onLocalUpdate(_cb: (update: Uint8Array) => void): () => void {
    return () => {}
  }

  onChange(cb: () => void): () => void {
    this.changeCallbacks.push(cb)
    return () => {
      const idx = this.changeCallbacks.indexOf(cb)
      if (idx !== -1) this.changeCallbacks.splice(idx, 1)
    }
  }

  dispose(): void {
    this.docs.clear()
    this.folders.clear()
    this.changeCallbacks.length = 0
  }

  private _notify(): void {
    for (const cb of this.changeCallbacks) cb()
  }
}
