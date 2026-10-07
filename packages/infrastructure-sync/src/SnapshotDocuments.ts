// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Documents « sans CRDT » d'une session de vault : un texte complet, en
// dernier-ecrivain-gagne. Ce registre porte ce qui ne depend pas du reseau
// (comptage des ouvertures, dernier contenu connu, abonnes). Chaque profil
// fournit seulement un canal : la room SignalR pour le serveur Savoire, le bus
// pour le connecteur local.
import type { DocumentRoomPresence } from '@savoire/plugin-api'
import type { ISnapshotDocument } from '@savoire/platform'

/** Ce qu'un profil fournit pour synchroniser UN document snapshot. */
export interface SnapshotChannel {
  /** Dernier contenu connu a l'ouverture. null = jamais ecrit. */
  readonly initial: Promise<string | null>
  push(content: string): Promise<void>
  /** Ecritures des autres pairs, jamais les notres. */
  onRemote(cb: (content: string, fromUserId: string) => void): () => void
  pushPresence(presence: DocumentRoomPresence): Promise<void>
  onPresence(cb: (userId: string, presence: DocumentRoomPresence) => void): () => void
  close(): void
}

class SharedSnapshotDocument implements ISnapshotDocument {
  refs = 0
  private current: string | null = null
  /** Une ecriture (locale ou distante) a eu lieu : l'etat initial est perime. */
  private touched = false
  private readonly ready: Promise<void>
  private readonly writeListeners = new Set<(content: string, fromUserId: string) => void>()
  private readonly unsubRemote: () => void

  constructor(private readonly channel: SnapshotChannel) {
    this.ready = channel.initial.then(
      (initial) => { if (!this.touched) this.current = initial },
      () => { /* canal en echec : le document est vu comme jamais ecrit */ },
    )
    this.unsubRemote = channel.onRemote((content, from) => {
      this.touched = true
      this.current = content
      for (const cb of this.writeListeners) cb(content, from)
    })
  }

  async load(): Promise<string | null> {
    await this.ready
    return this.current
  }

  async write(content: string): Promise<void> {
    this.touched = true
    this.current = content
    await this.channel.push(content)
  }

  onRemoteWrite(cb: (content: string, fromUserId: string) => void): () => void {
    this.writeListeners.add(cb)
    return () => { this.writeListeners.delete(cb) }
  }

  updatePresence(presence: DocumentRoomPresence): Promise<void> {
    return this.channel.pushPresence(presence)
  }

  onPresence(cb: (userId: string, presence: DocumentRoomPresence) => void): () => void {
    return this.channel.onPresence(cb)
  }

  dispose(): void {
    this.writeListeners.clear()
    this.unsubRemote()
    this.channel.close()
  }
}

export class SnapshotDocuments {
  private readonly docs = new Map<string, SharedSnapshotDocument>()

  constructor(private readonly openChannel: (docId: string) => SnapshotChannel) {}

  /** Ouvre (ou reprend) un document. Chaque open() appelle un close(). */
  open(docId: string): ISnapshotDocument {
    let doc = this.docs.get(docId)
    if (!doc) {
      doc = new SharedSnapshotDocument(this.openChannel(docId))
      this.docs.set(docId, doc)
    }
    doc.refs++
    return doc
  }

  close(docId: string): void {
    const doc = this.docs.get(docId)
    if (!doc) return
    doc.refs--
    if (doc.refs > 0) return
    this.docs.delete(docId)
    doc.dispose()
  }

  /** Lecture ponctuelle. Un document jamais ecrit se lit comme un texte vide. */
  async read(docId: string): Promise<string> {
    const doc = this.open(docId)
    try {
      return (await doc.load()) ?? ''
    } finally {
      this.close(docId)
    }
  }

  dispose(): void {
    for (const doc of this.docs.values()) doc.dispose()
    this.docs.clear()
  }
}
