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
//
// Demande a un agent : un commentaire peut etre adresse a un agent (« Demander
// à… », ou « @Nom »). La demande vit sur la racine du fil (`request`), avec
// son etat : un agent de l'appli la traite tout de suite, une IA externe la
// lit par son outil list_requests. Elle n'est jamais traitee deux fois.
import { lineHunks, mergeHunks } from './lineDiff'
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

/**
 * Une demande adressee a un agent, sur la racine d'un fil de commentaire.
 *  - via   : 'app', un agent de l'appli la traite des qu'elle est posee ;
 *            'external', une IA externe (MCP) la prendra ;
 *  - state : open (a prendre), running (un agent de l'appli y travaille),
 *            done (repondue), failed (echec : on peut relancer).
 */
export interface ReviewRequest {
  agentId: string
  agentName: string
  via: 'app' | 'external'
  state: 'open' | 'running' | 'done' | 'failed'
  /** L'entree qui porte la demande, si ce n'est pas la racine (une relance dans le fil). */
  entryId?: string
  /** Date ISO de la demande (ou de sa relance). */
  askedAt: string
  doneAt?: string
  /** Pourquoi l'agent de l'appli a echoue. */
  error?: string
}

/** A qui l'on demande, et ou la demande sera traitee. */
export type ReviewRequestTarget = Pick<ReviewRequest, 'agentId' | 'agentName' | 'via'>

/** Le texte d'une note, pour ancrer et pour appliquer une suggestion. */
export interface ReviewText extends ICollaborativeText {
  /** Remplace [from, to) par `text`, en une modification. */
  replace(from: number, to: number, text: string): void
}

export class ReviewConflictError extends Error {}

/** Taille maximale du payload d'une proposition (JSON), comme MAX_PROPOSAL_BYTES de plugin-api. */
const MAX_PAYLOAD_BYTES = 256 * 1024

/** Taille maximale de la cible d'un commentaire (JSON). */
const MAX_TARGET_BYTES = 16 * 1024

/** Copie JSON d'une valeur, au plus `max` octets. */
function asJson(value: unknown, max: number, what: string): unknown {
  let json: string
  try { json = JSON.stringify(value) } catch { throw new Error(`${what} illisible (JSON attendu)`) }
  if (json === undefined) throw new Error(`${what} vide`)
  if (new TextEncoder().encode(json).length > max) throw new Error(`${what} trop grosse`)
  return JSON.parse(json)
}

/** Longueur maximale d'un passage cite. */
const MAX_QUOTE = 2000

/** Au-dela, une demande « en cours » est tenue pour interrompue (on peut la relancer). */
export const REQUEST_STALE_MS = 3 * 60_000

export interface ReviewEntry {
  id: string
  docId: string
  /**
   * 'comment' : un commentaire. 'suggestion' : une modification proposee du
   * passage ancre. 'edit' : la trace d'une ecriture d'agent.
   */
  kind: 'comment' | 'edit' | 'suggestion' | 'proposal'
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
  /**
   * Proposition d'un plugin (autre type de document : base, dessin...) : son
   * type (« base.cell ») et ce qu'il faut appliquer. Voir ReviewAPI.
   */
  proposalType?: string
  payload?: unknown
  /**
   * Ce que vise un commentaire sur un document de plugin (une cellule, une
   * forme, un passage d'un texte) : JSON choisi par le plugin.
   */
  target?: unknown
  /** Statut d'un fil de commentaires (sur la racine seulement). */
  status?: ReviewStatus
  statusBy?: Actor
  statusAt?: string
  /** Suggestion acceptee en partie (certaines lignes seulement). */
  partial?: boolean
  /** Demande adressee a un agent (racine d'un fil de commentaire seulement). */
  request?: ReviewRequest
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

  /** Le fil d'une entree (sa racine et ses reponses) ; undefined s'il n'existe pas. */
  thread(id: string): ReviewThread | undefined {
    const all = this.entries()
    let root = all.find(e => e.id === id)
    // Borne : une boucle de parents (donnees abimees) ne bloque pas.
    for (let depth = 0; root?.parentId && depth < 32; depth++) { const parent = root.parentId; root = all.find(e => e.id === parent) }
    if (root?.parentId) return undefined
    if (!root) return undefined
    const rootId = root.id
    return { root, replies: all.filter(e => e.parentId === rootId).sort(byDate) }
  }

  /**
   * Ouvre un fil, sur la note entiere ou sur un passage. `target` : ce que
   * vise le commentaire dans un document de plugin (JSON). `ask` : le
   * commentaire est une demande a cet agent.
   */
  comment(docId: string, text: string, author: Actor, anchor?: ReviewAnchor, target?: unknown, ask?: ReviewRequestTarget): ReviewEntry {
    const aim = target === undefined ? undefined : asJson(target, MAX_TARGET_BYTES, 'cible')
    return this.add({
      docId, kind: 'comment', text, author, status: 'open', ...(anchor ? { anchor } : {}), ...(aim !== undefined ? { target: aim } : {}),
      ...(ask ? { request: this.newRequest(ask) } : {}),
    })
  }

  // ── Demandes a un agent ──────────────────────────────────────────────────

  /** Une demande neuve : prise tout de suite par l'appli ('running'), ou a prendre par une IA externe ('open'). */
  private newRequest(ask: ReviewRequestTarget, entryId?: string): ReviewRequest {
    return {
      agentId: ask.agentId, agentName: ask.agentName, via: ask.via, state: ask.via === 'app' ? 'running' : 'open',
      askedAt: this.now().toISOString(), ...(entryId ? { entryId } : {}),
    }
  }

  /**
   * Adresse (ou relance) une demande sur un fil de commentaire existant.
   * `entryId` : la reponse de la personne qui porte la demande (absent : la
   * racine). Refuse si un agent de l'appli y travaille deja.
   */
  ask(rootId: string, ask: ReviewRequestTarget, entryId?: string): ReviewEntry {
    const root = this.root(rootId)
    if (root.kind !== 'comment') throw new Error('une demande se pose sur un commentaire')
    if (root.request?.state === 'running' && !this.stale(root.request)) throw new Error('un agent travaille déjà sur cette demande')
    const next: ReviewEntry = { ...root, request: this.newRequest(ask, entryId ?? root.request?.entryId), ...(root.status && root.status !== 'open' ? { status: 'open' as const } : {}) }
    this.map.set(root.id, next)
    return next
  }

  /** Une demande « en cours » depuis trop longtemps : l'appli qui la traitait a ete fermee. */
  stale(request: ReviewRequest): boolean {
    return request.state === 'running' && this.now().getTime() - Date.parse(request.askedAt) > REQUEST_STALE_MS
  }

  /** La demande de ce fil est-elle encore celle que cet agent de l'appli a prise (`askedAt`) ? */
  isRunning(rootId: string, askedAt: string): boolean {
    const r = this.thread(rootId)?.root.request
    return !!r && r.state === 'running' && r.askedAt === askedAt
  }

  /**
   * L'agent de l'appli a fini (ou echoue) la demande qu'il avait prise
   * (`askedAt`). Rien ne change si elle a ete relancee ou close entre-temps :
   * jamais deux fois.
   */
  finishRequest(rootId: string, askedAt: string, state: 'done' | 'failed', error?: string): ReviewEntry | null {
    if (!this.isRunning(rootId, askedAt)) return null
    return this.setRequest(this.root(rootId), state, error)
  }

  /**
   * L'agent `agentId` a repondu dans ce fil (outil reply), pour `userId` : si
   * une demande ouverte lui est adressee par cette personne, elle est close.
   * Rend true si elle l'etait.
   */
  closeRequest(rootId: string, agentId: string, userId: string): boolean {
    const thread = this.thread(rootId)
    if (!thread || !this.askedBy(thread, agentId, userId)) return false
    this.setRequest(thread.root, 'done')
    return true
  }

  /** Ce qui porte la demande d'un fil : la racine, ou la reponse de la personne qui l'a relance. */
  static askOf(thread: ReviewThread): ReviewEntry {
    const id = thread.root.request?.entryId
    return (id ? thread.replies.find(r => r.id === id) : undefined) ?? thread.root
  }

  /** La demande ouverte de ce fil est-elle adressee a cet agent, par cette personne ? */
  private askedBy(thread: ReviewThread, agentId: string, userId: string): boolean {
    const r = thread.root.request
    if (thread.root.kind !== 'comment' || !r || r.agentId !== agentId || r.state !== 'open') return false
    const author = ReviewService.askOf(thread).author
    return author.kind === 'user' && author.userId === userId
  }

  private setRequest(root: ReviewEntry, state: 'done' | 'failed', error?: string): ReviewEntry {
    const { error: _old, ...rest } = root.request!
    const request: ReviewRequest = { ...rest, state, ...(state === 'done' ? { doneAt: this.now().toISOString() } : {}), ...(error ? { error: error.slice(0, 500) } : {}) }
    const next: ReviewEntry = { ...root, request }
    this.map.set(root.id, next)
    return next
  }

  /**
   * Les demandes ouvertes que `userId` a adressees a cet agent (IA externe, ou
   * assistant qui les liste). Celles d'un autre membre n'en sont pas :
   * personne ne fait agir l'IA d'un autre.
   */
  openRequests(agentId: string, userId: string): ReviewThread[] {
    const all = this.entries()
    return all
      .filter(e => !e.parentId && e.request?.agentId === agentId && (e.status ?? 'open') === 'open')
      .sort(byDate)
      .map(root => ({ root, replies: all.filter(e => e.parentId === root.id).sort(byDate) }))
      .filter(t => this.askedBy(t, agentId, userId))
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

  /**
   * Propose une modification d'un autre type de document (voir ReviewAPI) :
   * `type` dit quel plugin sait l'appliquer, `payload` quoi appliquer (JSON).
   */
  propose(docId: string, type: string, payload: unknown, author: Actor, note = ''): ReviewEntry {
    if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(type)) throw new Error('type de proposition invalide')
    const json = asJson(payload, MAX_PAYLOAD_BYTES, 'proposition')
    return this.add(
      { docId, kind: 'proposal', text: note.trim() || 'Proposition', author, status: 'open', proposalType: type, payload: json },
      { allowEmpty: true },
    )
  }

  /**
   * Une proposition a ete appliquee au document (par le plugin de son type) :
   * elle passe a « acceptee ». Refuse une proposition deja traitee.
   */
  markApplied(rootId: string, by: Actor): ReviewEntry {
    const root = this.root(rootId)
    if (root.kind !== 'proposal') throw new Error('ce fil n\'est pas une proposition')
    if (root.status && root.status !== 'open') throw new Error('proposition deja traitee')
    const next: ReviewEntry = { ...root, status: 'accepted', statusBy: by, statusAt: this.now().toISOString() }
    this.map.set(root.id, next)
    return next
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
  /**
   * Accepte une suggestion. `hunks` : seulement ces blocs de lignes (voir
   * lineHunks), le reste du passage est garde ; la suggestion est alors
   * acceptee en partie.
   */
  accept(rootId: string, text: ReviewText, by: Actor, hunks?: number[]): ReviewEntry {
    const root = this.root(rootId)
    if (root.kind !== 'suggestion' || !root.anchor || root.replacement === undefined) throw new Error('ce fil n\'est pas une suggestion')
    if (root.status && root.status !== 'open') throw new Error('suggestion deja traitee')
    const at = ReviewService.locate(root.anchor, text)
    if (!at) throw new ReviewConflictError('Le passage a disparu de la note.')
    if (at.current !== root.anchor.quote) throw new ReviewConflictError('Le passage a changé depuis la suggestion.')
    const total = hunks ? lineHunks(root.anchor.quote, root.replacement).length : 0
    const partial = !!hunks && hunks.length < total
    if (hunks && hunks.length === 0) throw new Error('aucune ligne choisie')
    text.replace(at.from, at.to, partial ? mergeHunks(root.anchor.quote, root.replacement, hunks!) : root.replacement)
    const next: ReviewEntry = { ...root, status: 'accepted', statusBy: by, statusAt: this.now().toISOString(), ...(partial ? { partial: true } : {}) }
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
