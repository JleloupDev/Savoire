// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// GraphWidget — force-directed graph of wikilink dependencies.
// Rendu SVG + simulation force maison (spring layout, requestAnimationFrame).
// Aucune dépendance externe.

import { useState, useEffect, useRef, useCallback } from 'react'
import type { ViewContext, WorkspaceAPI } from '@savoire/plugin-api'
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

function buildSimulation(nodes: GraphNode[], edges: GraphEdge[]): { simNodes: SimNode[]; simEdges: SimEdge[] } {
  const simNodes: SimNode[] = nodes.map((n, i) => ({
    ...n,
    x: 300 + 200 * Math.cos((i / nodes.length) * Math.PI * 2),
    y: 300 + 200 * Math.sin((i / nodes.length) * Math.PI * 2),
    vx: 0, vy: 0,
  }))

  const nodeById = new Map(simNodes.map(n => [n.docId, n]))
  const nodeByPathStem = new Map(simNodes.map(n => [n.path.replace(/\.md$/, ''), n]))

  const simEdges: SimEdge[] = []
  for (const e of edges) {
    const src = nodeById.get(e.sourceId)
    const tgt = nodeById.get(e.targetPath)
      ?? nodeByPathStem.get(e.targetPath)
      ?? nodeByPathStem.get(e.targetPath.replace(/\.md$/, ''))
    if (src && tgt && src !== tgt) {
      simEdges.push({ source: src, target: tgt, type: e.linkType })
    }
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

function GraphPanel({ contributor, workspace }: {
  contributor: GraphIndexContributor
  workspace: WorkspaceAPI
}) {
  const [, setTick]            = useState(0)
  const [activePath, setActivePath] = useState<string | null>(
    () => workspace.getActiveDocument()?.path ?? null,
  )
  const simRef     = useRef<{ nodes: SimNode[]; edges: SimEdge[] } | null>(null)
  const rafRef     = useRef<number | null>(null)
  const svgRef     = useRef<SVGSVGElement>(null)
  const [size, setSize] = useState({ w: 400, h: 400 })

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

  // Rebuild sim when index changes
  const rebuild = useCallback(() => {
    const nodes = contributor.getNodes()
    const edges = contributor.getAllEdges()
    const { simNodes, simEdges } = buildSimulation(nodes, edges)
    simRef.current = { nodes: simNodes, edges: simEdges }
    setTick(t => t + 1)
  }, [contributor])

  useEffect(() => {
    rebuild()
    const unsub = workspace.subscribeDocumentIndexed?.(() => rebuild())
    return unsub
  }, [workspace, rebuild])

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
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', background: 'var(--background-primary, #fff)' }}>
      {/* Header */}
      <div style={{ padding: '6px 10px', borderBottom: '1px solid var(--background-modifier-border, #ccc)', flexShrink: 0 }}>
        <span style={{ fontSize: '0.65rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.1em', color: 'var(--text-muted, #888)' }}>
          Graphe — {sim?.nodes.length ?? 0} notes · {sim?.edges.length ?? 0} liens
        </span>
      </div>

      {/* SVG */}
      <div style={{ flex: 1, position: 'relative', overflow: 'hidden' }}>
        {(!sim || sim.nodes.length === 0) ? (
          <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.78rem', color: 'var(--text-muted, #888)', fontStyle: 'italic' }}>
            Ouvre et édite des notes pour les voir apparaître.
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
                stroke={e.type === 'embed' ? 'var(--color-accent, #7c3aed)' : 'var(--background-modifier-border, #aaa)'}
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
                    fill={isActive ? 'var(--color-accent, #7c3aed)' : 'var(--text-normal, #333)'}
                    fillOpacity={isActive ? 1 : 0.7}
                    stroke={isActive ? 'var(--color-accent, #7c3aed)' : 'var(--background-modifier-border, #aaa)'}
                    strokeWidth={1.5}
                  />
                  <text
                    x={0} y={-10}
                    textAnchor="middle"
                    fontSize={9}
                    fill={isActive ? 'var(--color-accent, #7c3aed)' : 'var(--text-muted, #666)'}
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
    private readonly contributor: GraphIndexContributor,
  ) {}

  render() {
    return <GraphPanel contributor={this.contributor} workspace={this.ctx.workspace} />
  }

  dispose(): void {}
}
