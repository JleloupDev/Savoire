// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import type { IndexContributor } from '@savoire/plugin-api'

export interface GraphNode {
  docId: string
  path: string
}

export interface GraphEdge {
  sourceId: string
  targetPath: string  // as written in [[...]], may not resolve to a known docId
  linkType: 'wikilink' | 'embed'
}

// Snapshot format persisted via IndexSnapshotController
interface GraphSnapshot {
  nodes: GraphNode[]
  edges: GraphEdge[]
}

const WIKILINK_RE = /(!?)\[\[([^\]|#\n]+?)(?:\|[^\]]*)?\]\]/g

export class GraphIndexContributor implements IndexContributor {
  readonly namespace = 'graph'

  // source docId → node info
  private nodes = new Map<string, GraphNode>()
  // source docId → outbound edges
  private edges = new Map<string, GraphEdge[]>()

  private _processedSeq = 0
  get processedSeq(): number { return this._processedSeq }

  restore(snapshot: string, processedSeq: number): void {
    try {
      const data = JSON.parse(snapshot) as GraphSnapshot
      this.nodes.clear()
      this.edges.clear()
      for (const n of data.nodes) this.nodes.set(n.docId, n)
      for (const e of data.edges) {
        const list = this.edges.get(e.sourceId) ?? []
        list.push(e)
        this.edges.set(e.sourceId, list)
      }
      this._processedSeq = processedSeq
    } catch {
      // corrupt snapshot — start fresh
    }
  }

  onOp(seq: number | null, docId: string, path: string, markdownContent: string): void {
    // Update node
    this.nodes.set(docId, { docId, path })

    // Replace outbound edges for this doc
    const outEdges: GraphEdge[] = []
    WIKILINK_RE.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = WIKILINK_RE.exec(markdownContent)) !== null) {
      const isEmbed = m[1] === '!'
      const targetPath = m[2].trim()
      outEdges.push({ sourceId: docId, targetPath, linkType: isEmbed ? 'embed' : 'wikilink' })
    }
    this.edges.set(docId, outEdges)

    if (seq !== null) this._processedSeq = seq
  }

  snapshot(): string {
    const nodes = [...this.nodes.values()]
    const edges: GraphEdge[] = []
    for (const list of this.edges.values()) edges.push(...list)
    return JSON.stringify({ nodes, edges } satisfies GraphSnapshot)
  }

  // ── Bulk load from server ────────────────────────────────────────────────

  /**
   * Initialise le graphe depuis les liens déjà calculés par le serveur.
   * Appelé une fois au chargement du vault pour éviter d'attendre que chaque
   * note soit ouverte et ré-indexée.
   * Les onOp() ultérieurs mettent à jour les nœuds individuellement.
   */
  bulkLoad(links: Array<{ sourceId: string; sourcePath: string; targetId: string | null; targetPath: string; linkType: string }>): void {
    for (const l of links) {
      this.nodes.set(l.sourceId, { docId: l.sourceId, path: l.sourcePath })
      const list = this.edges.get(l.sourceId) ?? []
      const exists = list.some(e => e.targetPath === l.targetPath)
      if (!exists) list.push({ sourceId: l.sourceId, targetPath: l.targetPath, linkType: l.linkType as 'wikilink' | 'embed' })
      this.edges.set(l.sourceId, list)
    }
  }

  // ── Query API ─────────────────────────────────────────────────────────────

  getNodes(): GraphNode[] {
    return [...this.nodes.values()]
  }

  /** All edges (forward links) in the graph. */
  getAllEdges(): GraphEdge[] {
    const result: GraphEdge[] = []
    for (const list of this.edges.values()) result.push(...list)
    return result
  }

  /** Outbound links from a given document. */
  getOutLinks(docId: string): GraphEdge[] {
    return this.edges.get(docId) ?? []
  }

  /** Documents that link TO this target path (backlinks, derived from forward links). */
  getBacklinks(targetPath: string): GraphNode[] {
    const stem = targetPath.replace(/\.md$/, '')
    const result: GraphNode[] = []
    for (const [sourceId, edges] of this.edges) {
      const matches = edges.some(e => {
        const eStem = e.targetPath.replace(/\.md$/, '')
        return e.targetPath === targetPath || eStem === stem || eStem === targetPath
      })
      if (matches) {
        const node = this.nodes.get(sourceId)
        if (node) result.push(node)
      }
    }
    return result
  }
}
