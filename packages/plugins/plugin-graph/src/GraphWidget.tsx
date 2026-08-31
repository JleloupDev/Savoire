// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// GraphWidget — force-directed graph of wikilink dependencies.
// Rendu SVG + simulation force maison (spring layout, requestAnimationFrame).
// Aucune dépendance externe.

import { useState, useEffect, useRef, useCallback } from 'react'
import type { ViewContext, WorkspaceAPI, VaultAPI } from '@savoire/plugin-api'
import type { GraphIndexContributor, GraphNode, GraphEdge } from './GraphIndexContributor'

// ── Force simulation ──────────────────────────────────────────────────────────

interface SimNode extends GraphNode {
  x: number
  y: number
  vx: number
  vy: number
}

interface SimEdge {
  source: SimNode
  target: SimNode
  type: 'wikilink' | 'embed'
}

function buildSimulation(
  nodes: GraphNode[],
  edges: GraphEdge[],
  size: { w: number; h: number },
): { simNodes: SimNode[]; simEdges: SimEdge[] } {
  // Cercle initial centre sur le canvas reel. Les valeurs etaient codees en
  // dur autour de (300, 300) : acceptable dans un panneau lateral etroit,
  // mais en vue principale les noeuds demarraient hors champ et la simulation
  // n'avait pas le temps de tous les ramener.
  const cx = size.w / 2
  const cy = size.h / 2
  const radius = Math.max(80, Math.min(size.w, size.h) * 0.35)
  const simNodes: SimNode[] = nodes.map((n, i) => ({
    ...n,
    x: cx + radius * Math.cos((i / Math.max(1, nodes.length)) * Math.PI * 2),
    y: cy + radius * Math.sin((i / Math.max(1, nodes.length)) * Math.PI * 2),
    vx: 0, vy: 0,
  }))

  const nodeById = new Map(simNodes.map(n => [n.docId, n]))
  // Un wikilink s'ecrit rarement comme le chemin complet : [[nouvelle-note]]
  // doit atteindre "dossier/nouvelle-note.md". On indexe donc chaque noeud par
  // son chemin, son radical sans extension, et son seul nom de fichier — le
  // tout insensible a la casse.
  const norm = (v: string) => v.trim().replace(/\.md$/i, '').toLowerCase()
  const byName = new Map<string, SimNode>()
  for (const n of simNodes) {
    byName.set(norm(n.path), n)
    const base = n.path.split('/').at(-1) ?? n.path
    if (!byName.has(norm(base))) byName.set(norm(base), n)
  }

  const simEdges: SimEdge[] = []
  const seen = new Set<string>()
  for (const e of edges) {
    const src = nodeById.get(e.sourceId)
    const tgt = nodeById.get(e.targetPath) ?? byName.get(norm(e.targetPath))
    if (!src || !tgt || src === tgt) continue
    // Deduplique : plusieurs liens vers la meme note ne font qu'une arete.
    const key = `${src.docId}->${tgt.docId}:${e.linkType}`
    if (seen.has(key)) continue
    seen.add(key)
    simEdges.push({ source: src, target: tgt, type: e.linkType })
  }

  return { simNodes, simEdges }
}

function tickSimulation(nodes: SimNode[], edges: SimEdge[], cx: number, cy: number): void {
  const REPULSION  = 4000
  const ATTRACTION = 0.04
  const DAMPING    = 0.85
  const CENTER_F   = 0.008

  // Repulsion between all node pairs
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i], b = nodes[j]
      const dx = b.x - a.x, dy = b.y - a.y
      const dist = Math.sqrt(dx * dx + dy * dy) || 1
      const force = REPULSION / (dist * dist)
      const fx = (dx / dist) * force, fy = (dy / dist) * force
      a.vx -= fx; a.vy -= fy
      b.vx += fx; b.vy += fy
    }
  }

  // Spring attraction on edges
  for (const e of edges) {
    const dx = e.target.x - e.source.x, dy = e.target.y - e.source.y
    const dist = Math.sqrt(dx * dx + dy * dy) || 1
    const force = (dist - 120) * ATTRACTION
    const fx = (dx / dist) * force, fy = (dy / dist) * force
    e.source.vx += fx; e.source.vy += fy
    e.target.vx -= fx; e.target.vy -= fy
  }

  // Center gravity
  for (const n of nodes) {
    n.vx += (cx - n.x) * CENTER_F
    n.vy += (cy - n.y) * CENTER_F
    n.vx *= DAMPING
    n.vy *= DAMPING
    n.x  += n.vx
    n.y  += n.vy
  }
}

// ── Component ─────────────────────────────────────────────────────────────────

function GraphPanel({ getContributor, workspace, vault }: {
  getContributor: () => GraphIndexContributor
  workspace: WorkspaceAPI
  vault: VaultAPI
}) {
  const [, setTick]            = useState(0)
  const [activePath, setActivePath] = useState<string | null>(
    () => workspace.getActiveDocument()?.path ?? null,
  )
  const simRef     = useRef<{ nodes: SimNode[]; edges: SimEdge[] } | null>(null)
  const rafRef     = useRef<number | null>(null)
  const svgRef     = useRef<SVGSVGElement>(null)
  const [size, setSize] = useState({ w: 400, h: 400 })
  // Miroir en ref : rebuild() a besoin de la taille courante sans se recreer
  // a chaque redimensionnement (sinon l'effet d'abonnement se relance).
  const sizeRef = useRef(size)
  sizeRef.current = size

  // Track SVG container size
  useEffect(() => {
    const svg = svgRef.current?.parentElement
    if (!svg) return
    const ro = new ResizeObserver(entries => {
      const { width, height } = entries[0].contentRect
      setSize({ w: width, h: height })
    })
    ro.observe(svg)
    return () => ro.disconnect()
  }, [])

  // Le graphe montre TOUT le vault, pas seulement ce qui a ete indexe.
  // L'index ne connait que les documents ouverts ou re-indexes : s'y limiter
  // faisait disparaitre les notes jamais ouvertes, et avec elles toutes les
  // aretes qui pointaient vers elles. Les noeuds viennent donc du repertoire
  // du vault, l'index n'apportant que les liens.
  const vaultNodesRef = useRef<GraphNode[]>([])

  const rebuild = useCallback(() => {
    const indexed = getContributor().getNodes()
    // Fusion par CHEMIN, pas par docId : le repertoire du vault et l'index ne
    // s'accordent pas toujours sur l'identifiant d'une note (resolveDocumentId
    // peut echouer et retomber sur le chemin), et fusionner par docId
    // dedoublait alors les noeuds. Le chemin, lui, identifie la note de facon
    // stable. L'entree de l'index gagne : elle porte le docId reel, celui
    // auquel les aretes font reference.
    const key = (path: string) => path.replace(/\.md$/i, '').toLowerCase()
    const merged = new Map<string, GraphNode>()
    for (const n of vaultNodesRef.current) merged.set(key(n.path), n)
    for (const n of indexed) merged.set(key(n.path), n)
    const edges = getContributor().getAllEdges()
    const { simNodes, simEdges } = buildSimulation([...merged.values()], edges, sizeRef.current)
    simRef.current = { nodes: simNodes, edges: simEdges }
    setTick(t => t + 1)
  }, [getContributor])

  const reloadVaultNodes = useCallback(async () => {
    try {
      const paths = await vault.list()
      vaultNodesRef.current = paths
        .filter(p => !p.endsWith('/'))
        .map(p => ({ docId: vault.resolveDocumentId(p) ?? p, path: p }))
    } catch (err) {
      console.warn('[graph] liste du vault indisponible', err)
      vaultNodesRef.current = []
    }
    rebuild()
  }, [vault, rebuild])

  useEffect(() => {
    void reloadVaultNodes()
    const unsubIndexed = workspace.subscribeDocumentIndexed?.(() => rebuild())
    // Creation, renommage, suppression d'une note : la liste change sans
    // qu'aucune indexation ne se produise.
    const unsubVault = workspace.subscribeVaultChange?.(() => void reloadVaultNodes())
    return () => { unsubIndexed?.(); unsubVault?.() }
  }, [workspace, rebuild, reloadVaultNodes])

  // Track active document
  useEffect(() => {
    const unsub = workspace.subscribeActiveDocument?.((path) => setActivePath(path))
    return unsub
  }, [workspace])

  // Animation loop
  useEffect(() => {
    const sim = simRef.current
    if (!sim || sim.nodes.length === 0) return

    let stopped = 0
    function frame() {
      if (!sim) return
      tickSimulation(sim.nodes, sim.edges, size.w / 2, size.h / 2)
      setTick(t => t + 1)
      stopped++
      // Run ~120 frames then stop until next rebuild
      if (stopped < 120) rafRef.current = requestAnimationFrame(frame)
    }
    rafRef.current = requestAnimationFrame(frame)
    return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current) }
  // simRef is the stable ref object; .current is read inside the effect, not tracked by React.
  }, [simRef, size])

  const sim = simRef.current

  const label = (path: string) => path.split('/').at(-1)?.replace(/\.md$/, '') ?? path

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', background: 'var(--bg-base)' }}>
      {/* Header */}
      <div style={{ padding: '6px 10px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
        <span style={{ fontSize: '0.65rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.1em', color: 'var(--text-muted)' }}>
          Graphe — {sim?.nodes.length ?? 0} notes · {sim?.edges.length ?? 0} liens
        </span>
      </div>

      {/* SVG */}
      <div style={{ flex: 1, position: 'relative', overflow: 'hidden' }}>
        {(!sim || sim.nodes.length === 0) ? (
          <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.78rem', color: 'var(--text-muted)', fontStyle: 'italic' }}>
            Ce vault ne contient aucune note.
          </div>
        ) : (
          <svg
            ref={svgRef}
            width={size.w}
            height={size.h}
            style={{ display: 'block' }}
          >
            {/* Edges */}
            {sim.edges.map((e, i) => (
              <line
                key={i}
                x1={e.source.x} y1={e.source.y}
                x2={e.target.x} y2={e.target.y}
                stroke={e.type === 'embed' ? 'var(--accent)' : 'var(--border)'}
                strokeOpacity={e.type === 'embed' ? 0.6 : 0.5}
                strokeWidth={e.type === 'embed' ? 1.5 : 1}
              />
            ))}

            {/* Nodes */}
            {sim.nodes.map(n => {
              const isActive = activePath === n.path
              return (
                <g
                  key={n.docId}
                  transform={`translate(${n.x},${n.y})`}
                  style={{ cursor: 'pointer' }}
                  onClick={() => void workspace.openFile(n.path)}
                >
                  <circle
                    r={isActive ? 7 : 5}
                    fill={isActive ? 'var(--accent)' : 'var(--text-muted)'}
                    fillOpacity={isActive ? 1 : 0.7}
                    stroke={isActive ? 'var(--accent)' : 'var(--border)'}
                    strokeWidth={1.5}
                  />
                  <text
                    x={0} y={-10}
                    textAnchor="middle"
                    fontSize={9}
                    fill={isActive ? 'var(--accent)' : 'var(--text-muted)'}
                    style={{ pointerEvents: 'none', userSelect: 'none' }}
                  >
                    {label(n.path)}
                  </text>
                </g>
              )
            })}
          </svg>
        )}
      </div>
    </div>
  )
}

// ── Widget wrapper ─────────────────────────────────────────────────────────────

import type { Widget } from '@savoire/plugin-api'

export class GraphWidget implements Widget {
  constructor(
    private readonly ctx: ViewContext,
    private readonly getContributor: () => GraphIndexContributor,
  ) {}

  render() {
    return <GraphPanel getContributor={this.getContributor} workspace={this.ctx.workspace} vault={this.ctx.vault} />
  }

  dispose(): void {}
}
