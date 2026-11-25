// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Le port des outils du socle (ADR-033). Deux implementations :
//  - l'appli, au-dessus de sa session de vault (apps/web/src/agents) ;
//  - le pair indexeur du serveur, au-dessus des journaux Yjs (apps/indexer).
//
// L'hote applique les droits de la PERSONNE (ACL) : une note qu'elle ne peut
// pas voir n'existe pas pour l'agent, une ecriture refusee leve une erreur.
// Les droits de l'AGENT (modes, portee) sont verifies avant, par la ToolBox.
import type { ToolActor } from '@savoire/plugin-api'
import type { TextChange } from './text'

export interface HostNoteRef {
  id: string
  path: string
}

export interface HostNote extends HostNoteRef {
  title: string
  content: string
  truncated?: boolean
}

export interface HostHit extends HostNoteRef {
  title?: string
  snippets?: string[]
}

export interface HostReviewEntry {
  id: string
  kind: 'comment' | 'edit' | 'suggestion' | 'proposal'
  text: string
  author: string
  authorIsAgent: boolean
  createdAt: string
  status?: string
  parentId?: string
  quote?: string
  replacement?: string
}

export class HostError extends Error {
  constructor(message: string, readonly code: 'not_found' | 'denied' | 'invalid' | 'unavailable' | 'conflict' = 'invalid') {
    super(message)
  }
}

export interface AgentToolHost {
  // ── Lecture ──
  listNotes(p: { folder?: string; limit: number; cursor?: string }): Promise<{ items: HostNoteRef[]; total?: number; next?: string }>
  search(p: { text: string; limit: number; folder?: string }): Promise<HostHit[]>
  /**
   * Le document seul, sans lire son contenu : une base (.base) ou un fichier
   * n'a pas toujours de texte. Null : introuvable, ou cache a la personne.
   */
  findNote(ref: { id?: string; path?: string }): Promise<HostNoteRef | null>
  /** Null : introuvable, ou cachee a la personne. */
  readNote(ref: { id?: string; path?: string }): Promise<HostNote | null>
  /**
   * Un pouvoir de l'index (links.*, tags.*, query.run), memes parametres et
   * resultats que le pair (indexer-protocol.md). Null : indisponible ici.
   */
  power(capability: string, method: string, params: Record<string, unknown>): Promise<unknown | null>
  listReview(docId: string): Promise<HostReviewEntry[]>

  // ── Contexte de l'editeur (editorContext.ts) : l'appli seule a un editeur ──
  /**
   * Ou etait la personne il y a `secondsAgo` secondes (note ouverte,
   * selection ou curseur), et l'age de cette entree. Null : rien d'ouvert.
   * Absent : pas d'editeur ici (le pair ; le serveur sert get_context lui-meme).
   */
  editorContext?(p: { secondsAgo: number }): Promise<{ entry: import('./editorContext').EditorContextEntry; ageSeconds: number } | null>
  /** Les marques de la personne pour l'IA dans ce vault : epingles, ou passages surlignes. */
  aiMarks?(kind: 'pin' | 'highlight'): Promise<import('./editorContext').AiMark[]>

  // ── Ecriture (au nom de la personne, avec l'agent comme auteur) ──
  /** Remplace [from, to) du texte de la note par `text`. */
  replaceText(docId: string, from: number, to: number, text: string, actor: ToolActor): Promise<void>
  createNote(path: string, content: string, actor: ToolActor): Promise<HostNoteRef>
  createFolder(path: string, actor: ToolActor): Promise<void>
  /** Rend le nouveau chemin. */
  moveNote(docId: string, newPath: string, actor: ToolActor): Promise<string>
  /** Rend le chemin dans la corbeille. */
  trashNote(docId: string, actor: ToolActor): Promise<string>
  /**
   * Inscrit au vault un fichier dont le serveur a deja range les octets sous
   * `fileId` (image envoyee par une IA), a ce chemin, range avec sa note.
   * Absent : l'hote ne sait pas recevoir de fichier (l'appli).
   */
  attachFile?(fileId: string, path: string, noteId: string, actor: ToolActor): Promise<HostNoteRef>

  // ── Revision ──
  comment(docId: string, text: string, actor: ToolActor, range?: { from: number; to: number }): Promise<string>
  reply(rootId: string, text: string, actor: ToolActor): Promise<string>
  /** Propose de remplacer [from, to) par `replacement` : rien ne change tant que la personne n'accepte pas. */
  suggest(docId: string, from: number, to: number, replacement: string, actor: ToolActor, note: string): Promise<string>
  /** Trace d'une ecriture directe de l'agent, dans la Revision. */
  recordEdit(docId: string, text: string, actor: ToolActor): Promise<void>

  // ── Ecriture fine (patch_note, effet de frappe) ──
  /**
   * Applique plusieurs remplacements en UNE ecriture : plages disjointes, dans
   * l'ordre, positions dans le texte d'avant. Absent : l'outil enchaine des
   * replaceText.
   *  - `typing` : un long texte est deroule par morceaux, en ecritures
   *    successives (effet de frappe, typing.ts) ;
   *  - `expect` : empreinte (textFingerprint) du texte sur lequel les plages
   *    ont ete calculees ; s'il a change, l'hote refuse (HostError 'conflict').
   */
  applyChanges?(docId: string, changes: readonly TextChange[], actor: ToolActor, opts?: { typing?: boolean; expect?: string }): Promise<void>
  /**
   * Resout les deux positions relatives Yjs d'une ancre (base64, anchor.ts)
   * dans le texte d'aujourd'hui. Null : l'une des deux ne se resout plus.
   * Absent : l'hote ne tient pas le Y.Doc ; l'ancre se resout par sa citation.
   */
  resolveRelative?(docId: string, start: string, end: string): Promise<{ from: number; to: number } | null>

  // ── Presence ──
  /**
   * Ce que l'agent fait sur une note, pour le montrer aux personnes qui l'ont
   * ouverte : il lit, il ecrit (from, to : positions dans le texte de la
   * note), puis plus rien ('idle').
   */
  signal?(s: { docId: string; state: 'reading' | 'writing' | 'idle'; from?: number; to?: number }): void
}
