// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Couche de revision : des fils de discussion sur une note, avec un statut,
// des suggestions de modification a accepter ou refuser, et la trace des
// modifications faites par un agent.
//
// Ancrage : un commentaire ou une suggestion peut viser un passage precis.
// Le passage est retenu par deux positions RELATIVES du CRDT (debut et fin) :
// elles suivent les modifications faites avant, apres ou autour, chez tous les
// membres. Le texte cite est garde aussi, pour l'afficher et pour verifier,
// avant d'accepter une suggestion, que le passage n'a pas change.
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
import type { ICollaborativeText, RelPosJSON } from '@savoire/domain-index'
import type { Actor } from './Actor'
import type { IVaultSyncSession } from './contracts'

export type ReviewStatus = 'open' | 'resolved' | 'rejected' | 'accepted'

/** Statuts qu'on choisit pour un fil de commentaires (une suggestion s'accepte ou se refuse). */
export const REVIEW_STATUSES: { id: ReviewStatus; label: string }[] = [
  { id: 'open', label: 'Ouvert' },
  { id: 'resolved', label: 'Résolu' },
  { id: 'rejected', label: 'Rejeté' },
]

/** Un passage d'une note : deux positions relatives du CRDT et le texte cite. */
export interface ReviewAnchor {
  from: RelPosJSON
  to: RelPosJSON
  quote: string
}

/** Le texte d'une note, pour ancrer et pour appliquer une suggestion. */
export interface ReviewText extends ICollaborativeText {
  /** Remplace [from, to) par `text`, en une modification. */
  replace(from: number, to: number, text: string): void
}

export class ReviewConflictError extends Error {}

/** Longueur maximale d'un passage cite. */
const MAX_QUOTE = 2000

export interface ReviewEntry {
  id: string
  docId: string
  /**
   * 'comment' : un commentaire. 'suggestion' : une modification proposee du
   * passage ancre. 'edit' : la trace d'une ecriture d'agent.
   */
  kind: 'comment' | 'edit' | 'suggestion'
  text: string
  author: Actor
  /** Date ISO. */
  createdAt: string
  /** Racine du fil. Absent : l'entree ouvre un fil. */
  parentId?: string
  /** Passage vise (racine seulement). Absent : la note entiere. */
  anchor?: ReviewAnchor
  /** Suggestion : le texte qui remplacerait le passage ('' : le supprimer). */
  replacement?: string
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

  /** Ouvre un fil, sur la note entiere ou sur un passage. */
  comment(docId: string, text: string, author: Actor, anchor?: ReviewAnchor): ReviewEntry {
    return this.add({ docId, kind: 'comment', text, author, status: 'open', ...(anchor ? { anchor } : {}) })
  }

  /**
   * Propose de remplacer le passage ancre par `replacement` ('' : le
   * supprimer). `note` : une explication, facultative.
   */
  suggest(docId: string, anchor: ReviewAnchor, replacement: string, author: Actor, note = ''): ReviewEntry {
    if (replacement === anchor.quote) throw new Error('la suggestion ne change rien')
    return this.add(
      { docId, kind: 'suggestion', text: note.trim() || 'Suggestion', author, status: 'open', anchor, replacement },
      { allowEmpty: true },
    )
  }

  /** Ancre le passage [from, to) du texte : il suivra les modifications. */
  static anchor(text: ICollaborativeText, from: number, to: number): ReviewAnchor {
    const a = Math.max(0, Math.min(from, to))
    const b = Math.min(text.length, Math.max(from, to))
    // Debut colle au caractere qui suit, fin au caractere qui precede : un
    // ajout juste avant ou juste apres le passage n'y entre pas.
    return { from: text.createRelPos(a, 0), to: text.createRelPos(b, -1), quote: text.slice(a, b).slice(0, MAX_QUOTE) }
  }

  /** Ou est le passage aujourd'hui. Null : il a disparu (supprime). */
  static locate(anchor: ReviewAnchor, text: ICollaborativeText): { from: number; to: number; current: string } | null {
    const from = text.resolveRelPos(anchor.from)
    const to = text.resolveRelPos(anchor.to)
    if (from === null || to === null || to < from) return null
    if (to === from && anchor.quote !== '') return null
    return { from, to, current: text.slice(from, to) }
  }

  /**
   * Accepte une suggestion : le passage est remplace dans la note, puis la
   * suggestion passe a « acceptee ». Refuse si le passage a change depuis.
   */
  accept(rootId: string, text: ReviewText, by: Actor): ReviewEntry {
    const root = this.root(rootId)
    if (root.kind !== 'suggestion' || !root.anchor || root.replacement === undefined) throw new Error('ce fil n\'est pas une suggestion')
    if (root.status && root.status !== 'open') throw new Error('suggestion deja traitee')
    const at = ReviewService.locate(root.anchor, text)
    if (!at) throw new ReviewConflictError('Le passage a disparu de la note.')
    if (at.current !== root.anchor.quote) throw new ReviewConflictError('Le passage a changé depuis la suggestion.')
    text.replace(at.from, at.to, root.replacement)
    const next: ReviewEntry = { ...root, status: 'accepted', statusBy: by, statusAt: this.now().toISOString() }
    this.map.set(root.id, next)
    return next
  }

  reply(rootId: string, text: string, author: Actor): ReviewEntry {
    const root = this.root(rootId)
    return this.add({ docId: root.docId, kind: 'comment', text, author, parentId: root.id })
  }

  setStatus(rootId: string, status: ReviewStatus, by: Actor): ReviewEntry {
    const root = this.root(rootId)
    if (root.kind === 'edit') throw new Error('une trace d\'ecriture n\'a pas de statut')
    // Une suggestion ne passe a « acceptee » que par accept() (qui modifie la note).
    if (status === 'accepted') throw new Error('accepter une suggestion passe par accept()')
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

  private add(entry: Omit<ReviewEntry, 'id' | 'createdAt'>, opts: { allowEmpty?: boolean } = {}): ReviewEntry {
    const text = entry.text.trim()
    if (!text && !opts.allowEmpty) throw new Error('commentaire vide')
    const full: ReviewEntry = { ...entry, text, id: crypto.randomUUID(), createdAt: this.now().toISOString() }
    this.map.set(full.id, full)
    return full
  }
}
