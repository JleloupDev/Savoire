// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// ─── Sync / DocumentRoom ─────────────────────────────────────────────────
//
// API format-agnostic de synchronisation temps réel pour les documents non-CRDT
// (Excalidraw, tableaux, schémas, etc.). Modèle last-write-wins par snapshot JSON.
//
// Usage dans un plugin :
//   const room = await api.sync.openRoom(vaultId, docId, userId)
//   room.onSnapshot((json, fromUserId) => { /* update local view */ })
//   room.pushSnapshot(json)    // debounced inside plugin
//   room.close()               // on FileView.destroy()

export interface DocumentRoomPresence {
  userId: string
  /** Couleur hex CSS affichée pour le curseur/avatar de cet utilisateur. */
  color?: string
  /** Nom d'affichage court. */
  displayName?: string
  /** Données arbitraires propres au plugin (ex. position curseur dans Excalidraw). */
  [key: string]: unknown
}

export interface DocumentRoom {
  /** Envoie un snapshot complet à la room (broadcast + persistance côté serveur). */
  pushSnapshot(snapshotJson: string): Promise<void>
  /** Diffuse la présence locale (curseur, avatar) — éphémère. */
  updatePresence(presence: DocumentRoomPresence): Promise<void>
  /** Appelé lorsqu'un autre client pousse un snapshot. */
  onSnapshot(cb: (snapshotJson: string, fromUserId: string) => void): () => void
  /** Appelé lorsqu'un autre client met à jour sa présence. */
  onPresence(cb: (userId: string, presence: DocumentRoomPresence) => void): () => void
  /** Ferme la connexion à la room et nettoie les listeners. */
  close(): Promise<void>
}

export interface SyncAPI {
  /**
   * Ouvre (ou récupère) une room de synchronisation pour un document donné.
   * Appelé dans FileView.mount() — un seul appel par document ouvert.
   */
  openRoom(vaultId: string, docId: string, userId: string): Promise<DocumentRoom>
}
