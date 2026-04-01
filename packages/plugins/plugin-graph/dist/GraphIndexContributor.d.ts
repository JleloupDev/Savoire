import type { IndexContributor } from '@poc/plugin-api';
export interface GraphNode {
    docId: string;
    path: string;
}
export interface GraphEdge {
    sourceId: string;
    targetPath: string;
    linkType: 'wikilink' | 'embed';
}
export declare class GraphIndexContributor implements IndexContributor {
    readonly namespace = "graph";
    private nodes;
    private edges;
    private _processedSeq;
    get processedSeq(): number;
    restore(snapshot: string, processedSeq: number): void;
    onOp(seq: number | null, docId: string, path: string, markdownContent: string): void;
    snapshot(): string;
    /**
     * Initialise le graphe depuis les liens déjà calculés par le serveur.
     * Appelé une fois au chargement du vault pour éviter d'attendre que chaque
     * note soit ouverte et ré-indexée.
     * Les onOp() ultérieurs mettent à jour les nœuds individuellement.
     */
    bulkLoad(links: Array<{
        sourceId: string;
        sourcePath: string;
        targetId: string | null;
        targetPath: string;
        linkType: string;
    }>): void;
    getNodes(): GraphNode[];
    /** All edges (forward links) in the graph. */
    getAllEdges(): GraphEdge[];
    /** Outbound links from a given document. */
    getOutLinks(docId: string): GraphEdge[];
    /** Documents that link TO this target path (backlinks, derived from forward links). */
    getBacklinks(targetPath: string): GraphNode[];
}
//# sourceMappingURL=GraphIndexContributor.d.ts.map