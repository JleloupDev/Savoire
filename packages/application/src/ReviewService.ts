// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Couche de revision, version 1 : des commentaires sur une note, sans ancrage,
// et la trace des modifications faites par un agent. Tout vit dans une carte
// partagee du vault (session.openSharedMap('review')) : synchronise entre les
// membres par le meme port que le reste, avec ou sans serveur.
import type { IIndexChannel } from '@savoire/plugin-api'
import type { Actor } from './Actor'
import type { IVaultSyncSession } from './contracts'

export interface ReviewEntry {
  id: string
  docId: string
  /** 'comment' : un commentaire. 'edit' : la trace d'une ecriture d'agent. */
  kind: 'comment' | 'edit'
  text: string
  author: Actor
  /** Date ISO. */
  createdAt: string
}

export class ReviewService {
  private readonly map: IIndexChannel

  constructor(session: IVaultSyncSession, private readonly now: () => Date = () => new Date()) {
    this.map = session.openSharedMap('review')
  }

  /** Entrees d'une note, de la plus ancienne a la plus recente. */
  list(docId: string): ReviewEntry[] {
    return this.map.getAll()
      .map(e => e.value as ReviewEntry)
      .filter(e => e?.docId === docId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
  }

  comment(docId: string, text: string, author: Actor): ReviewEntry {
    return this.add({ docId, kind: 'comment', text, author })
  }

  /** Trace une ecriture faite par un agent : ce n'est pas la personne qui a tape. */
  recordEdit(docId: string, text: string, author: Actor): ReviewEntry {
    return this.add({ docId, kind: 'edit', text, author })
  }

  onChange(cb: () => void): () => void {
    return this.map.onChange(() => cb())
  }

  private add(entry: Omit<ReviewEntry, 'id' | 'createdAt'>): ReviewEntry {
    const text = entry.text.trim()
    if (!text) throw new Error('commentaire vide')
    const full: ReviewEntry = { ...entry, text, id: crypto.randomUUID(), createdAt: this.now().toISOString() }
    this.map.set(full.id, full)
    return full
  }
}
