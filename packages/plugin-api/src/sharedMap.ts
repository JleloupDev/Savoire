// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// ─── Donnees partagees d'un document ──────────────────────────────────────
//
// Premiere brique de l'API CRDT pour les plugins : une carte cle -> valeur,
// synchronisee entre tous les membres du vault, propre a un document.
//
// Semantique : deux membres qui ecrivent deux cles differentes ne
// s'ecrasent jamais ; sur la meme cle, le dernier gagne. Ecrire chaque
// element (un message, une forme, une ligne) sous sa propre cle donne donc
// une edition simultanee sans perte.
//
// La carte est ouverte par la session du vault (le port de synchro) : elle
// marche avec ou sans serveur, et n'expose aucune bibliotheque CRDT.

import type { ISharedTree } from './sharedTree'

export interface ISharedMap {
  set(key: string, value: unknown): void
  delete(key: string): void
  /** Etat courant complet. */
  getAll(): { id: string; value: unknown }[]
  /** Changements locaux comme distants. Rend une fonction de desabonnement. */
  onChange(cb: (changedKeys: string[]) => void): () => void
}

export interface DocumentSharedData {
  /** Ouvre (ou reprend) une carte partagee de ce document, par nom. Idempotent. */
  openMap(name: string): ISharedMap
  /**
   * Ouvre un arbre ANNEXE de ce document : un document CRDT rattache,
   * synchronise a part, qu'on ne charge qu'a la demande. Sert a decouper un
   * gros contenu (les lots de lignes d'une base) : un membre ne charge que les
   * morceaux qu'il lit, une modification ne touche qu'un morceau.
   * Memes regles qu'un arbre de document : vide a l'ouverture, etat connu
   * en lot 'remote' ensuite. Idempotent par nom ; closeTree le libere.
   * Absent si le profil ne sait pas ouvrir de document annexe.
   */
  openTree?(name: string): Promise<ISharedTree>
  /** Libere un arbre annexe ouvert par openTree. */
  closeTree?(name: string): void
}
