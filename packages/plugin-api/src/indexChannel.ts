// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Canal d'index partage entre pairs. Un canal par namespace : un client ne
// synchronise que les index dont ses plugins charges ont besoin.
//
// La carte est clefee par documentId, et la valeur est la liste des entrees
// que CE document produit pour CE namespace. « Recalculer un document » se
// traduit donc par un seul `set`, et « oublier un document » par un seul
// `delete` — exactement la semantique d'un Y.Map (dernier ecrivain gagne, par
// clef, sans conflit entre clefs). Deux pairs qui editent des notes
// differentes ne se croisent jamais ; sur la meme note ils convergent, et
// comme computeEntries() est pure ils auraient de toute facon calcule la
// meme chose depuis le meme texte converge.
//
// Le transport est le probleme du profil de synchronisation, pas celui des
// plugins : voir IVaultSyncSession.openIndex().

export interface IIndexChannel {
  /** Remplace les entrees de ce document. */
  set(docId: string, entries: unknown): void
  /** Oublie ce document (note supprimee). */
  delete(docId: string): void
  /** Etat courant complet, tous documents confondus. */
  getAll(): { id: string; value: unknown }[]
  /** Notifie des changements, locaux comme distants. */
  onChange(cb: (changedIds: string[]) => void): () => void
  dispose(): void
}
