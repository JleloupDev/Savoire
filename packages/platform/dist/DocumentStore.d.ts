/**
 * DocumentStore — gestion des documents ouverts en mémoire.
 *
 */
import type { IDocumentFetcher, IDocumentMeta } from './ports';
export interface OpenDocument {
    readonly docId: string;
    readonly path: string;
    readonly content: string;
    readonly metadata: IDocumentMeta;
    refCount: number;
}
export declare class DocumentStore {
    private readonly fetcher;
    private readonly writer?;
    private readonly cache;
    private readonly pending;
    constructor(fetcher: IDocumentFetcher, writer?: IDocumentFetcher | undefined);
    open(vaultId: string, docId: string, metadata: IDocumentMeta, token: string): Promise<OpenDocument>;
    /**
     * Lit le contenu d'un document sans modifier le refCount.
     * - Si le document est déjà en cache (ouvert dans l'éditeur) : retourne le contenu en mémoire.
     * - Sinon :
     *   - avec metadata : charge et garde en cache "passif" (refCount=0), utile pour les embeds.
     *   - sans metadata : charge via le fetcher sans cache durable.
     *
     * see ADR-010
     */
    readContent(vaultId: string, docId: string, token: string, metadata?: IDocumentMeta): Promise<string>;
    /** Lit directement via le writer (REST) sans passer par le CRDT. */
    readDirect(vaultId: string, docId: string, token: string): Promise<string>;
    writeContent(vaultId: string, docId: string, content: string, token: string): Promise<void>;
    close(vaultId: string, docId: string): void;
    get(vaultId: string, docId: string): OpenDocument | undefined;
    get size(): number;
    private ensureCached;
}
//# sourceMappingURL=DocumentStore.d.ts.map