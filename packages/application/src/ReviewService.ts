// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Couche de revision : des fils de discussion sur une note, avec un statut,
// et la trace des modifications faites par un agent. Pas encore d'ancrage :
// un fil vise la note entiere.
//
// Tout vit dans une carte partagee du vault (session.openSharedMap('review')),
// a cote du document et jamais dedans : synchronise par le meme port que le
// reste, avec ou sans serveur, quel que soit le format du fichier.
//
// Une entree = une cle de la carte. Une reponse est une entree qui pointe vers
// la racine de son fil : deux personnes qui repondent en meme temps ne
// s'ecrasent pas. Le statut vit sur la racine ; deux changements simultanes
// de statut se departagent par le dernier ecrivain.
import type { IIndexChannel } from '@savoire/plugin-api'
import type { Actor } from './Actor'
import type { IVaultSyncSession } from './contracts'

export type ReviewStatus = 'open' | 'resolved' | 'rejected'

export const REVIEW_STATUSES: { id: ReviewStatus; label: string }[] = [
  { id: 'open', label: 'Ouvert' },
  { id: 'resolved', label: 'Résolu' },
  { id: 'rejected', label: 'Rejeté' },
]

export interface ReviewEntry {
  id: string
  docId: string
  /** 'comment' : un commentaire. 'edit' : la trace d'une ecriture d'agent. */
  kind: 'comment' | 'edit'
  text: string
  author: Actor
  /** Date ISO. */
  createdAt: string
  /** Racine du fil. Absent : l'entree ouvre un fil. */
  parentId?: string
  /** Statut d'un fil de commentaires (sur la racine seulement). */
  status?: ReviewStatus
  statusBy?: Actor
  statusAt?: string
}

export interface ReviewThread {
  root: ReviewEntry
  replies: ReviewEntry[]
}

const byDate = (a: ReviewEntry, b: ReviewEntry): number =>
  a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)

export class ReviewService {
  private readonly map: IIndexChannel

  constructor(session: IVaultSyncSession, private readonly now: () => Date = () => new Date()) {
    this.map = session.openSharedMap('review')
  }

  /** Toutes les entrees d'une note, a plat, de la plus ancienne a la plus recente. */
  list(docId: string): ReviewEntry[] {
    return this.entries().filter(e => e.docId === docId).sort(byDate)
  }

  /** Fils d'une note : chaque racine avec ses reponses, dans l'ordre. */
  threads(docId: string): ReviewThread[] {
    const all = this.list(docId)
    return all
      .filter(e => !e.parentId)
      .map(root => ({ root, replies: all.filter(e => e.parentId === root.id) }))
  }

  /** Ouvre un fil. */
  comment(docId: string, text: string, author: Actor): ReviewEntry {
    return this.add({ docId, kind: 'comment', text, author, status: 'open' })
  }

  reply(rootId: string, text: string, author: Actor): ReviewEntry {
    const root = this.root(rootId)
    return this.add({ docId: root.docId, kind: 'comment', text, author, parentId: root.id })
  }

  setStatus(rootId: string, status: ReviewStatus, by: Actor): ReviewEntry {
    const root = this.root(rootId)
    if (root.kind !== 'comment') throw new Error('seul un fil de commentaires a un statut')
    const next: ReviewEntry = { ...root, status, statusBy: by, statusAt: this.now().toISOString() }
    this.map.set(root.id, next)
    return next
  }

  /** Trace une ecriture faite par un agent : ce n'est pas la personne qui a tape. */
  recordEdit(docId: string, text: string, author: Actor): ReviewEntry {
    return this.add({ docId, kind: 'edit', text, author })
  }

  onChange(cb: () => void): () => void {
    return this.map.onChange(() => cb())
  }

  private entries(): ReviewEntry[] {
    return this.map.getAll().map(e => e.value as ReviewEntry).filter(e => !!e?.docId)
  }

  /** Racine d'un fil. Une reponse a une reponse rattache au meme fil. */
  private root(id: string): ReviewEntry {
    const entry = this.entries().find(e => e.id === id)
    if (!entry) throw new Error(`fil introuvable : ${id}`)
    return entry.parentId ? this.root(entry.parentId) : entry
  }

  private add(entry: Omit<ReviewEntry, 'id' | 'createdAt'>): ReviewEntry {
    const text = entry.text.trim()
    if (!text) throw new Error('commentaire vide')
    const full: ReviewEntry = { ...entry, text, id: crypto.randomUUID(), createdAt: this.now().toISOString() }
    this.map.set(full.id, full)
    return full
  }
}
