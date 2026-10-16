// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// ─── Texte partage d'un document ──────────────────────────────────────────
//
// Deuxieme brique de l'API CRDT des plugins (apres ISharedMap) : un texte que
// plusieurs membres editent en meme temps, sans perte. C'est le texte d'un
// document de type 'crdt' (une note, un plan .outline, une page .page).
//
// Le contrat n'expose aucune bibliotheque CRDT. Il parle en « deltas » :
// une suite d'operations qui parcourt le texte du debut a la fin,
//
//   [{ retain: 5 }, { delete: 2 }, { insert: 'abc' }]
//   = garder 5 caracteres, en supprimer 2, inserer « abc ».
//
// Les positions comptent en unites UTF-16 (comme String.length en JS).
//
// Une bibliotheque d'edition qui ne parle que Yjs (y-prosemirror...) n'est
// pas branchee directement : le plugin la traduit vers ce contrat
// (adaptateur interne au plugin). Voir docs/Architecture/plugin-crdt-api.md.

export type TextDeltaOp =
  | { retain: number }
  | { insert: string }
  | { delete: number }

export type TextDelta = TextDeltaOp[]

/** D'ou vient un changement : de ce client, ou d'un autre membre. */
export type ChangeOrigin = 'local' | 'remote'

export interface ISharedText {
  /** Texte courant complet. */
  toString(): string
  readonly length: number
  insert(index: number, text: string): void
  delete(index: number, length: number): void
  /** Applique plusieurs operations en une seule modification. */
  applyDelta(delta: TextDelta): void
  /**
   * Chaque modification, locale ou distante, en delta par rapport au texte
   * d'avant. Rend une fonction de desabonnement.
   */
  onChange(cb: (delta: TextDelta, origin: ChangeOrigin) => void): () => void
}
