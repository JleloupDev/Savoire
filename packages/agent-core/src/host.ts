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
  /** Null : introuvable, ou cachee a la personne. */
  readNote(ref: { id?: string; path?: string }): Promise<HostNote | null>
  /**
   * Un pouvoir de l'index (links.*, tags.*, query.run), memes parametres et
   * resultats que le pair (indexer-protocol.md). Null : indisponible ici.
   */
  power(capability: string, method: string, params: Record<string, unknown>): Promise<unknown | null>
  listReview(docId: string): Promise<HostReviewEntry[]>

  // ── Ecriture (au nom de la personne, avec l'agent comme auteur) ──
  /** Remplace [from, to) du texte de la note par `text`. */
  replaceText(docId: string, from: number, to: number, text: string, actor: ToolActor): Promise<void>
  createNote(path: string, content: string, actor: ToolActor): Promise<HostNoteRef>
  createFolder(path: string, actor: ToolActor): Promise<void>
  /** Rend le nouveau chemin. */
  moveNote(docId: string, newPath: string, actor: ToolActor): Promise<string>
  /** Rend le chemin dans la corbeille. */
  trashNote(docId: string, actor: ToolActor): Promise<string>

  // ── Revision ──
  comment(docId: string, text: string, actor: ToolActor, range?: { from: number; to: number }): Promise<string>
  reply(rootId: string, text: string, actor: ToolActor): Promise<string>
  /** Propose de remplacer [from, to) par `replacement` : rien ne change tant que la personne n'accepte pas. */
  suggest(docId: string, from: number, to: number, replacement: string, actor: ToolActor, note: string): Promise<string>
  /** Trace d'une ecriture directe de l'agent, dans la Revision. */
  recordEdit(docId: string, text: string, actor: ToolActor): Promise<void>
}
