// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import type { ICollaborativeText } from './ICollaborativeText'
import type { AnchorIndex } from './AnchorIndex'

/**
 * Contributeur d'ANCRES. Chemin d'indexation distinct et purement local : il
 * suit les positions dans le texte CRDT, ne produit aucune entree partagee et
 * ne traverse jamais le reseau. Volontairement separe des deux familles
 * ci-dessous, qu'il ne recoupe pas.
 */
export interface AnchorContributor {
  readonly namespace: string
  onTextChange?(text: ICollaborativeText, docId: string, index: AnchorIndex): void
}

/** Une entree d'index partagee, produite par un document.
 *  A ne pas confondre avec IndexEntry (index d'ancres, purement local). */
export interface SharedIndexEntry {
  key: string
  value: unknown
}

/**
 * Contributeur d'index synchronise entre pairs.
 *
 * Le contributeur ne connait ni transport, ni persistance, ni numero de
 * sequence : il declare un namespace et une FONCTION PURE qui, pour un
 * document, rend ses entrees. Le runtime possede la carte partagee, y ecrit
 * les entrees, efface celles des documents disparus, et rappelle
 * onEntriesChanged() quand quoi que ce soit bouge — edition locale ou arrivee
 * d'un pair.
 *
 * L'ancien contrat (snapshot / restore / processedSeq / onOp) supposait un
 * serveur : un sequenceur central pour ordonner les ops, un blob d'etat a
 * stocker, et le markdown complet transporte comme charge utile. Rien de tout
 * cela n'a de sens entre pairs. Voir LocalIndexContributor pour le seul cas
 * qui reste sur ce modele.
 */
export interface IndexContributor {
  readonly namespace: string

  /**
   * Entrees produites par CE document. Doit etre pure : meme document, memes
   * entrees. C'est ce qui rend la convergence sure quand deux pairs indexent
   * la meme note.
   */
  computeEntries(docId: string, path: string, markdown: string): SharedIndexEntry[]

  /**
   * Reconstruit le modele de lecture depuis l'etat partage complet.
   * Appele apres toute modification, d'ou qu'elle vienne.
   */
  onEntriesChanged(byDoc: ReadonlyMap<string, SharedIndexEntry[]>): void

  /** Ancres CRDT — chemin d'indexation distinct, purement local. */
  onTextChange?(text: ICollaborativeText, docId: string, index: AnchorIndex): void
}

/**
 * Contributeur qui n'est PAS partage entre pairs : il se reconstruit
 * localement et se persiste localement.
 *
 * Un seul cas aujourd'hui, `fulltext` : MiniSearch serialise un index
 * monolithique, non decomposable par document, donc impossible a exprimer en
 * carte CRDT. C'est un index derive — un accelerateur de recherche, pas une
 * connaissance partagee — que n'importe quel pair peut reconstruire depuis les
 * documents qu'il possede. Son sort definitif reste a trancher.
 */
export interface LocalIndexContributor {
  readonly namespace: string
  readonly processedSeq: number
  restore(snapshot: string, processedSeq: number): void
  snapshot(): string
  onOp(seq: number | null, docId: string, path: string, markdownContent: string): void
  onTextChange?(text: ICollaborativeText, docId: string, index: AnchorIndex): void
}

/** Un registre d'index contient les deux familles. */
export type AnyIndexContributor = IndexContributor | LocalIndexContributor

export function isSharedContributor(c: AnyIndexContributor): c is IndexContributor {
  return typeof (c as IndexContributor).computeEntries === 'function'
}
