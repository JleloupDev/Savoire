// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Canal d'index du profil serveur Savoire : un Y.Map clefe par documentId,
// relaye par le hub en binaire OPAQUE. Le serveur ne lit rien, il empile et
// rediffuse — meme traitement que le repertoire de vault et les documents.
//
// C'est le remplacant de l'ancien PushIndexOp, qui expediait le markdown
// complet au serveur pour qu'il le sequence et le rediffuse : le serveur y
// etait un relais de contenu, pas un passe-plat.
import * as Y from 'yjs'
import type { IIndexChannel } from '@savoire/plugin-api'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const Y_ = Y as Record<string, any>

export interface YMapIndexChannelTransport {
  /** Envoie une mise a jour binaire aux autres pairs. */
  push(namespace: string, update: Uint8Array): void
  /** Recoit les mises a jour distantes de ce namespace. */
  subscribe(namespace: string, cb: (update: Uint8Array) => void): () => void
}

export class YMapIndexChannel implements IIndexChannel {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly doc: any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly map: any
  private readonly callbacks: ((changedIds: string[]) => void)[] = []
  private readonly unsubTransport: () => void
  private applyingRemote = false
  private disposed = false

  constructor(
    private readonly namespace: string,
    transport?: YMapIndexChannelTransport,
  ) {
    this.doc = new Y_.Doc()
    this.map = this.doc.getMap('entries')

    this.map.observe((event: { keysChanged: Set<string> }) => {
      const changed = [...event.keysChanged]
      for (const cb of this.callbacks) cb(changed)
    })

    // Ne pas renvoyer au reseau ce qu'on vient d'en recevoir.
    this.doc.on('update', (update: Uint8Array) => {
      if (this.applyingRemote || this.disposed) return
      transport?.push(this.namespace, update)
    })

    this.unsubTransport = transport?.subscribe(this.namespace, (update) => {
      this.applyingRemote = true
      try { Y_.applyUpdate(this.doc, update) } finally { this.applyingRemote = false }
    }) ?? (() => {})
  }

  set(docId: string, entries: unknown): void {
    if (this.disposed) return
    this.map.set(docId, entries)
  }

  delete(docId: string): void {
    if (this.disposed) return
    this.map.delete(docId)
  }

  getAll(): { id: string; value: unknown }[] {
    if (this.disposed) return []
    const out: { id: string; value: unknown }[] = []
    this.map.forEach((value: unknown, id: string) => out.push({ id, value }))
    return out
  }

  onChange(cb: (changedIds: string[]) => void): () => void {
    this.callbacks.push(cb)
    return () => {
      const i = this.callbacks.indexOf(cb)
      if (i >= 0) this.callbacks.splice(i, 1)
    }
  }

  /** Etat complet encode — pour amorcer un pair qui rejoint. */
  encodeState(): Uint8Array {
    return Y_.encodeStateAsUpdate(this.doc)
  }

  applyUpdate(update: Uint8Array): void {
    if (this.disposed) return
    this.applyingRemote = true
    try { Y_.applyUpdate(this.doc, update) } finally { this.applyingRemote = false }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.unsubTransport()
    this.callbacks.length = 0
    this.doc.destroy()
  }
}
