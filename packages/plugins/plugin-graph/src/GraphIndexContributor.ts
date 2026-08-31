// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import type { IndexContributor, SharedIndexEntry } from '@savoire/plugin-api'

/** Ce qu'un document publie dans le namespace 'graph'. */
interface GraphDocEntry {
  path: string
  targets: Array<{ targetPath: string; linkType: 'wikilink' | 'embed' }>
}

export interface GraphNode {
  docId: string
  path: string
}

export interface GraphEdge {
  sourceId: string
  targetPath: string  // as written in [[...]], may not resolve to a known docId
  linkType: 'wikilink' | 'embed'
}

const WIKILINK_RE = /(!?)\[\[([^\]|#\n]+?)(?:\|[^\]]*)?\]\]/g

export class GraphIndexContributor implements IndexContributor {
  readonly namespace = 'graph'

  // Modeles de lecture, reconstruits depuis la carte partagee.
  private nodes = new Map<string, GraphNode>()
  private edges = new Map<string, GraphEdge[]>()

  computeEntries(_docId: string, path: string, markdown: string): SharedIndexEntry[] {
    const targets: Array<{ targetPath: string; linkType: 'wikilink' | 'embed' }> = []
    WIKILINK_RE.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = WIKILINK_RE.exec(markdown)) !== null) {
      targets.push({ targetPath: m[2].trim(), linkType: m[1] === '!' ? 'embed' : 'wikilink' })
    }
    return [{ key: 'links', value: { path, targets } satisfies GraphDocEntry }]
  }

  onEntriesChanged(byDoc: ReadonlyMap<string, SharedIndexEntry[]>): void {
    this.nodes = new Map()
    this.edges = new Map()
    for (const [docId, entries] of byDoc) {
      const entry = entries.find(e => e.key === 'links')
      if (!entry) continue
      const { path, targets } = entry.value as GraphDocEntry
      this.nodes.set(docId, { docId, path })
      this.edges.set(docId, targets.map(t => ({ sourceId: docId, ...t })))
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
