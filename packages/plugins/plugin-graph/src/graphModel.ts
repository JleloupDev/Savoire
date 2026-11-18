// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// Modele du graphe : notes, liens resolus, voisins, filtres.
// Pur (pas de DOM) : se teste seul.

import { createLinkResolver } from '@savoire/plugin-api'
import type { GraphNode, GraphEdge } from './GraphIndexContributor'
import { type ForceParams, type SimNode, type SimLink, DEFAULT_FORCES, spiralPosition } from './simulation'

export interface ModelNode extends SimNode {
  id: string
  path: string
  label: string
  /** Premier dossier du chemin ('' a la racine). */
  folder: string
  /** Couleur de son dossier, ou null (racine, ou dossier hors des plus gros). */
  color: string | null
  /** Image, PDF, video... (masques par defaut, comme dans Obsidian). */
  attachment: boolean
  /** Nombre de liens, dans tout le graphe : donne la taille du point. */
  degree: number
  neighbors: Set<ModelNode>
}

export interface ModelLink extends SimLink<ModelNode> {
  type: 'wikilink' | 'embed'
}

export interface GraphModel {
  nodes: ModelNode[]
  links: ModelLink[]
  byPath: Map<string, ModelNode>
}

export interface GraphSettings {
  mode: 'global' | 'local'
  /** Profondeur du graphe local (1 a 5). */
  depth: number
  search: string
  showOrphans: boolean
  showAttachments: boolean
  showArrows: boolean
  colorByFolder: boolean
  /** Zoom a partir duquel les noms apparaissent. */
  labelZoom: number
  nodeSize: number
  linkWidth: number
  forces: ForceParams
}

export const DEFAULT_SETTINGS: GraphSettings = {
  mode: 'global',
  depth: 1,
  search: '',
  showOrphans: true,
  showAttachments: false,
  showArrows: false,
  colorByFolder: true,
  labelZoom: 1.1,
  nodeSize: 1,
  linkWidth: 1,
  forces: { ...DEFAULT_FORCES },
}

/** Couleurs des dossiers : lisibles sur fond clair comme sombre. */
export const FOLDER_PALETTE = [
  '#e06c75', '#4f9be8', '#7cb860', '#e2ad3b', '#b77ad9',
  '#3fb4c0', '#d6874a', '#e872b0', '#8b8cf0', '#9aa83a',
]

const ATTACHMENT_RE = /\.(png|jpe?g|gif|webp|svg|bmp|avif|ico|pdf|mp4|webm|mov|mkv|mp3|wav|ogg|m4a|flac|zip)$/i

/** Cle stable d'une note : son chemin, sans extension .md ni casse. */
export const pathKey = (path: string) => path.replace(/\.md$/i, '').toLowerCase()

export function noteLabel(path: string): string {
  const name = path.split('/').at(-1) ?? path
  return name.replace(/\.md$/i, '')
}

/**
 * Construit le modele. `previous` : l'ancien modele, dont les notes gardent
 * leur position (le dessin ne saute pas quand une note change). Une note
 * neuve part a cote d'une voisine deja placee, sinon sur la spirale.
 */
export function buildModel(rawNodes: GraphNode[], rawEdges: GraphEdge[], previous?: GraphModel): GraphModel {
  const old = previous?.byPath
  const nodes: ModelNode[] = []
  const byId = new Map<string, ModelNode>()
  const byPath = new Map<string, ModelNode>()
  const fresh: ModelNode[] = []

  for (const n of rawNodes) {
    const key = pathKey(n.path)
    if (byPath.has(key)) continue
    const was = old?.get(key)
    const node: ModelNode = {
      id: n.docId,
      path: n.path,
      label: noteLabel(n.path),
      folder: n.path.includes('/') ? n.path.slice(0, n.path.indexOf('/')) : '',
      color: null,
      attachment: ATTACHMENT_RE.test(n.path),
      degree: 0,
      neighbors: new Set(),
      x: was?.x ?? NaN, y: was?.y ?? NaN,
      vx: 0, vy: 0,
      fx: null, fy: null,
    }
    if (!was) fresh.push(node)
    nodes.push(node)
    byId.set(n.docId, node)
    byPath.set(key, node)
  }

  // Une couleur par dossier, les plus gros d'abord : deux dossiers ne
  // partagent jamais une couleur (un hachage les faisait se rencontrer).
  const sizes = new Map<string, number>()
  for (const n of nodes) if (n.folder && !n.attachment) sizes.set(n.folder, (sizes.get(n.folder) ?? 0) + 1)
  const ranked = [...sizes].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, FOLDER_PALETTE.length)
  const palette = new Map(ranked.map(([f], i) => [f, FOLDER_PALETTE[i]]))
  for (const n of nodes) n.color = palette.get(n.folder) ?? null

  // Un wikilink s'ecrit rarement comme le chemin complet : [[nouvelle-note]]
  // doit atteindre "dossier/nouvelle-note.md". Meme resolution qu'Obsidian
  // (plugin-api, links.ts), memoisee par cible.
  const exact = new Map(nodes.map(n => [n.path, n]))
  const resolver = createLinkResolver(nodes.map(n => n.path))
  const resolved = new Map<string, ModelNode | undefined>()
  const resolve = (target: string): ModelNode | undefined => {
    if (!resolved.has(target)) {
      const p = resolver.resolve(target)
      resolved.set(target, p === undefined ? undefined : exact.get(p))
    }
    return resolved.get(target)
  }

  const links: ModelLink[] = []
  const seen = new Set<string>()
  for (const e of rawEdges) {
    const src = byId.get(e.sourceId)
    const tgt = byId.get(e.targetPath) ?? resolve(e.targetPath)
    if (!src || !tgt || src === tgt) continue
    // Plusieurs liens vers la meme note ne font qu'un trait.
    const key = `${src.id}->${tgt.id}`
    if (seen.has(key)) continue
    seen.add(key)
    links.push({ source: src, target: tgt, type: e.linkType })
    src.degree++; tgt.degree++
    src.neighbors.add(tgt); tgt.neighbors.add(src)
  }

  // Placement des notes neuves.
  let spiral = 0
  let free = previous ? previous.nodes.length : 0
  for (const n of fresh) {
    const anchor = [...n.neighbors].find(v => !Number.isNaN(v.x))
    if (anchor) {
      const a = (spiral++ * 2.39996) % (Math.PI * 2)
      n.x = anchor.x + Math.cos(a) * 30
      n.y = anchor.y + Math.sin(a) * 30
    } else {
      const p = spiralPosition(free++, 12)
      n.x = p.x; n.y = p.y
    }
  }

  return { nodes, links, byPath }
}

export interface GraphViewSet {
  nodes: ModelNode[]
  links: ModelLink[]
}

/**
 * Ce qu'on montre : filtre de recherche, pieces jointes, graphe local
 * (voisins jusqu'a `depth` liens de la note active, dans les deux sens),
 * notes isolees.
 */
export function selectView(model: GraphModel, s: GraphSettings, activePath: string | null): GraphViewSet {
  let keep = new Set<ModelNode>()
  const q = s.search.trim().toLowerCase()
  for (const n of model.nodes) {
    if (n.attachment && !s.showAttachments) continue
    if (q && !n.path.toLowerCase().includes(q)) continue
    keep.add(n)
  }

  if (s.mode === 'local') {
    const root = activePath ? model.byPath.get(pathKey(activePath)) : undefined
    const local = new Set<ModelNode>()
    if (root) {
      // La note active reste visible, meme si un filtre l'ecarte.
      local.add(root)
      let frontier = [root]
      for (let d = 0; d < s.depth && frontier.length; d++) {
        const next: ModelNode[] = []
        for (const n of frontier) {
          for (const v of n.neighbors) {
            if (local.has(v) || !keep.has(v)) continue
            local.add(v)
            next.push(v)
          }
        }
        frontier = next
      }
    }
    keep = local
  }

  const links = model.links.filter(l => keep.has(l.source) && keep.has(l.target))
  if (!s.showOrphans && s.mode === 'global') {
    const linked = new Set<ModelNode>()
    for (const l of links) { linked.add(l.source); linked.add(l.target) }
    keep = linked
  }
  return { nodes: model.nodes.filter(n => keep.has(n)), links }
}
