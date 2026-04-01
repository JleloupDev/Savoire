const WIKILINK_RE = /(!?)\[\[([^\]|#\n]+?)(?:\|[^\]]*)?\]\]/g;
export class GraphIndexContributor {
    namespace = 'graph';
    // source docId → node info
    nodes = new Map();
    // source docId → outbound edges
    edges = new Map();
    _processedSeq = 0;
    get processedSeq() { return this._processedSeq; }
    restore(snapshot, processedSeq) {
        try {
            const data = JSON.parse(snapshot);
            this.nodes.clear();
            this.edges.clear();
            for (const n of data.nodes)
                this.nodes.set(n.docId, n);
            for (const e of data.edges) {
                const list = this.edges.get(e.sourceId) ?? [];
                list.push(e);
                this.edges.set(e.sourceId, list);
            }
            this._processedSeq = processedSeq;
        }
        catch {
            // corrupt snapshot — start fresh
        }
    }
    onOp(seq, docId, path, markdownContent) {
        // Update node
        this.nodes.set(docId, { docId, path });
        // Replace outbound edges for this doc
        const outEdges = [];
        WIKILINK_RE.lastIndex = 0;
        let m;
        while ((m = WIKILINK_RE.exec(markdownContent)) !== null) {
            const isEmbed = m[1] === '!';
            const targetPath = m[2].trim();
            outEdges.push({ sourceId: docId, targetPath, linkType: isEmbed ? 'embed' : 'wikilink' });
        }
        this.edges.set(docId, outEdges);
        if (seq !== null)
            this._processedSeq = seq;
    }
    snapshot() {
        const nodes = [...this.nodes.values()];
        const edges = [];
        for (const list of this.edges.values())
            edges.push(...list);
        return JSON.stringify({ nodes, edges });
    }
    // ── Bulk load from server ────────────────────────────────────────────────
    /**
     * Initialise le graphe depuis les liens déjà calculés par le serveur.
     * Appelé une fois au chargement du vault pour éviter d'attendre que chaque
     * note soit ouverte et ré-indexée.
     * Les onOp() ultérieurs mettent à jour les nœuds individuellement.
     */
    bulkLoad(links) {
        for (const l of links) {
            this.nodes.set(l.sourceId, { docId: l.sourceId, path: l.sourcePath });
            const list = this.edges.get(l.sourceId) ?? [];
            const exists = list.some(e => e.targetPath === l.targetPath);
            if (!exists)
                list.push({ sourceId: l.sourceId, targetPath: l.targetPath, linkType: l.linkType });
            this.edges.set(l.sourceId, list);
        }
    }
    // ── Query API ─────────────────────────────────────────────────────────────
    getNodes() {
        return [...this.nodes.values()];
    }
    /** All edges (forward links) in the graph. */
    getAllEdges() {
        const result = [];
        for (const list of this.edges.values())
            result.push(...list);
        return result;
    }
    /** Outbound links from a given document. */
    getOutLinks(docId) {
        return this.edges.get(docId) ?? [];
    }
    /** Documents that link TO this target path (backlinks, derived from forward links). */
    getBacklinks(targetPath) {
        const stem = targetPath.replace(/\.md$/, '');
        const result = [];
        for (const [sourceId, edges] of this.edges) {
            const matches = edges.some(e => {
                const eStem = e.targetPath.replace(/\.md$/, '');
                return e.targetPath === targetPath || eStem === stem || eStem === targetPath;
            });
            if (matches) {
                const node = this.nodes.get(sourceId);
                if (node)
                    result.push(node);
            }
        }
        return result;
    }
}
//# sourceMappingURL=GraphIndexContributor.js.map