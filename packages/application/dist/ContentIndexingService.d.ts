import type { HookRegistry, IIndexRegistry } from '@poc/plugin-api';
import type { ILocalIndexStorage } from '@poc/platform';
import type { VaultHubLike } from './contracts';
/**
 * ContentIndexingService — abonné à onDocumentStabilized, dispatche aux IndexContributors.
 *
 * see ADR-015
 *
 * Cycle de vie :
 *   1. restore()       — au démarrage, recharge les snapshots persistés
 *   2. init()          — s'abonne au hook (appeler après que les plugins ont chargé)
 *   3. attachHub(hub)  — appelé après activation du vault, branche la sync serveur
 */
export declare class ContentIndexingService {
    private readonly hooks;
    private readonly indexRegistry;
    private readonly storage;
    private getHub;
    private hubUnsubscribe;
    private onIndexed;
    constructor(hooks: HookRegistry, indexRegistry: IIndexRegistry, storage: ILocalIndexStorage);
    /** Callback appelé après chaque indexation locale (pour notifier les panels). */
    setOnIndexed(cb: (docId: string, path: string) => void): void;
    /** Recharge les snapshots depuis le stockage. Appeler avant init(). */
    restore(): Promise<void>;
    /** S'abonne à onDocumentStabilized. Appeler après que les plugins ont chargé. */
    init(): void;
    /**
     * Branche la sync serveur. Appelé après activation du vault.
     * Le hub est consulté via getHub() à chaque op (pas capturé à l'enregistrement)
     * pour éviter des refs périmées après changement de vault.
     */
    attachHub(getHub: () => VaultHubLike | null): void;
    detachHub(): void;
    /**
     * Indexe immédiatement un contenu shadow pré-converti.
     * Utilisé par les FileViews non-Markdown (Excalidraw, etc.) via onFileContentStabilized.
     * Le contenu est déjà en Markdown (shadow document) — pas de contentExtractor ici.
     */
    indexNow(docId: string, path: string, shadowMarkdown: string): Promise<void>;
}
//# sourceMappingURL=ContentIndexingService.d.ts.map