export interface DocumentRoomPresence {
    userId: string;
    /** Couleur hex CSS affichée pour le curseur/avatar de cet utilisateur. */
    color?: string;
    /** Nom d'affichage court. */
    displayName?: string;
    /** Données arbitraires propres au plugin (ex. position curseur dans Excalidraw). */
    [key: string]: unknown;
}
export interface DocumentRoom {
    /** Envoie un snapshot complet à la room (broadcast + persistance côté serveur). */
    pushSnapshot(snapshotJson: string): Promise<void>;
    /** Diffuse la présence locale (curseur, avatar) — éphémère. */
    updatePresence(presence: DocumentRoomPresence): Promise<void>;
    /** Appelé lorsqu'un autre client pousse un snapshot. */
    onSnapshot(cb: (snapshotJson: string, fromUserId: string) => void): () => void;
    /** Appelé lorsqu'un autre client met à jour sa présence. */
    onPresence(cb: (userId: string, presence: DocumentRoomPresence) => void): () => void;
    /** Ferme la connexion à la room et nettoie les listeners. */
    close(): Promise<void>;
}
export interface SyncAPI {
    /**
     * Ouvre (ou récupère) une room de synchronisation pour un document donné.
     * Appelé dans FileView.mount() — un seul appel par document ouvert.
     */
    openRoom(vaultId: string, docId: string, userId: string): Promise<DocumentRoom>;
}
//# sourceMappingURL=sync.d.ts.map