// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import * as Y from 'yjs'
import type { IDocumentMeta, IVaultDirectory } from '@savoire/platform'

// TypeScript 5.9 + moduleResolution:bundler fails to follow Yjs's .js→.d.ts
// re-export chain. Cast once; runtime behaviour is validated by tests.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const Y_ = Y as Record<string, any>

type VaultEntry = { path: string }

export class YMapVaultDirectory implements IVaultDirectory {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly doc: any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly map: any
  private readonly changeCallbacks: (() => void)[] = []

  constructor() {
    this.doc = new Y_.Doc()
    this.map = this.doc.getMap('vault')
    this.map.observe(() => {
      for (const cb of this.changeCallbacks) cb()
    })
  }

  getAll(): readonly IDocumentMeta[] {
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

  applyServerState(docs: IDocumentMeta[]): void {
    // origin='server' prevents onLocalUpdate from treating this as a local mutation
    this.doc.transact(() => {
      this.map.clear()
      for (const doc of docs) this.map.set(doc.id, { path: doc.path })
    }, 'server')
  }

  encodeFullState(): Uint8Array {
    return Y_.encodeStateAsUpdate(this.doc) as Uint8Array
  }

  applyUpdate(update: Uint8Array): void {
    // origin='remote' prevents onLocalUpdate from re-broadcasting applied updates
    Y_.applyUpdate(this.doc, update, 'remote')
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
    this.doc.destroy()
  }
}
