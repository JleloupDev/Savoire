import type { IndexContributor } from '@poc/plugin-api';
export interface BacklinkEntry {
    /** UUID du document source. */
    docId: string;
    /** Chemin vault-relatif du document source. */
    path: string;
}
/**
 * Maintient l'index des backlinks en mémoire.
 *
 * Structure : Map<targetPath, BacklinkEntry[]>
 *   - targetPath : chemin ou titre wikilink (ex. "s1.md" ou "My Note")
 *   - BacklinkEntry : { docId, path } du document source
 *
 * see ADR-017
 */
export declare class BacklinksIndexContributor implements IndexContributor {
    readonly namespace = "backlinks";
    private readonly index;
    private _processedSeq;
    get processedSeq(): number;
    restore(snapshot: string, processedSeq: number): void;
    onOp(seq: number | null, docId: string, path: string, markdownContent: string): void;
    snapshot(): string;
    /**
     * Retourne les documents qui contiennent un lien vers `targetPath`.
     * Recherche par chemin exact ou par nom de fichier sans extension.
     */
    getBacklinks(targetPath: string): BacklinkEntry[];
}
//# sourceMappingURL=BacklinksIndexContributor.d.ts.map