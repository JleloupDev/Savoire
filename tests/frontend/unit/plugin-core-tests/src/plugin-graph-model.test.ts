// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// Graphe : modele (liens resolus, filtres, graphe local) et simulation.
import { describe, it, expect } from 'vitest'
import { buildModel, selectView, DEFAULT_SETTINGS, type GraphSettings } from '../../../../../packages/plugins/plugin-graph/src/graphModel'
import { ForceSimulation, type SimNode } from '../../../../../packages/plugins/plugin-graph/src/simulation'

const s = (patch: Partial<GraphSettings> = {}): GraphSettings => ({ ...DEFAULT_SETTINGS, ...patch })
const node = (path: string) => ({ docId: path, path })
const link = (from: string, to: string) => ({ sourceId: from, targetPath: to, linkType: 'wikilink' as const })

// a - b - c - d, e isolee, une image liee a a.
const raw = () => ({
  nodes: ['a.md', 'dir/b.md', 'c.md', 'd.md', 'e.md', 'img/photo.png'].map(node),
  edges: [link('a.md', 'b'), link('dir/b.md', 'c'), link('c.md', 'd'), link('a.md', 'photo.png'), link('a.md', 'b')],
})

describe('modele du graphe', () => {
  it('resout les liens par nom, deduplique, compte les liens', () => {
    const { nodes, edges } = raw()
    const m = buildModel(nodes, edges)
    expect(m.links).toHaveLength(4)
    const b = m.byPath.get('dir/b')!
    expect(b.degree).toBe(2)
    expect(b.folder).toBe('dir')
    expect(m.byPath.get('img/photo.png')!.attachment).toBe(true)
  })

  it('pieces jointes masquees par defaut, notes isolees au choix', () => {
    const { nodes, edges } = raw()
    const m = buildModel(nodes, edges)
    expect(selectView(m, s(), null).nodes.map(n => n.path)).not.toContain('img/photo.png')
    expect(selectView(m, s({ showAttachments: true }), null).nodes.map(n => n.path)).toContain('img/photo.png')
    expect(selectView(m, s({ showOrphans: false }), null).nodes.map(n => n.path)).not.toContain('e.md')
  })

  it('filtre sur le chemin', () => {
    const { nodes, edges } = raw()
    const v = selectView(buildModel(nodes, edges), s({ search: 'DIR/' }), null)
    expect(v.nodes.map(n => n.path)).toEqual(['dir/b.md'])
    expect(v.links).toHaveLength(0)
  })

  it('graphe local : voisins jusqu a la profondeur, dans les deux sens', () => {
    const { nodes, edges } = raw()
    const m = buildModel(nodes, edges)
    const paths = (depth: number) => selectView(m, s({ mode: 'local', depth }), 'c.md').nodes.map(n => n.path).sort()
    expect(paths(1)).toEqual(['c.md', 'd.md', 'dir/b.md'])
    expect(paths(2)).toEqual(['a.md', 'c.md', 'd.md', 'dir/b.md'])
    expect(selectView(m, s({ mode: 'local' }), null).nodes).toHaveLength(0)
  })

  it('une reconstruction garde les positions ; une note neuve part pres de sa voisine', () => {
    const { nodes, edges } = raw()
    const m1 = buildModel(nodes, edges)
    const a = m1.byPath.get('a')!
    a.x = 500; a.y = -300
    const m2 = buildModel([...nodes, node('f.md')], [...edges, link('f.md', 'a')], m1)
    expect(m2.byPath.get('a')).toMatchObject({ x: 500, y: -300 })
    const f = m2.byPath.get('f')!
    expect(Math.hypot(f.x - 500, f.y + 300)).toBeLessThan(50)
  })
})

describe('simulation', () => {
  const mk = (n: number): SimNode[] => Array.from({ length: n }, (_, i) => ({ x: (i % 70) * 3, y: Math.floor(i / 70) * 3, vx: 0, vy: 0, fx: null, fy: null }))

  it('ecarte les notes, rapproche les liees, et s arrete seule', () => {
    const nodes = mk(30)
    const sim = new ForceSimulation()
    sim.setGraph(nodes, [{ source: nodes[0], target: nodes[29] }])
    let steps = 0
    while (sim.active && steps < 1000) { sim.tick(); steps++ }
    expect(sim.active).toBe(false)
    expect(steps).toBeLessThan(400)
    const d = (a: SimNode, b: SimNode) => Math.hypot(a.x - b.x, a.y - b.y)
    // Liees : pres de la longueur de repos. Non liees : pas empilees.
    expect(d(nodes[0], nodes[29])).toBeLessThan(120)
    let min = Infinity
    for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) min = Math.min(min, d(nodes[i], nodes[j]))
    expect(min).toBeGreaterThan(5)
    for (const n of nodes) expect(Number.isFinite(n.x) && Number.isFinite(n.y)).toBe(true)
  })

  it('une note tenue ne bouge pas', () => {
    const nodes = mk(10)
    nodes[3].fx = 42; nodes[3].fy = -7
    const sim = new ForceSimulation()
    sim.setGraph(nodes, [])
    for (let i = 0; i < 20; i++) sim.tick()
    expect(nodes[3]).toMatchObject({ x: 42, y: -7 })
  })

  it('5 000 notes : un pas reste court (Barnes-Hut)', () => {
    const nodes = mk(5000)
    const links = nodes.slice(1).map((n, i) => ({ source: nodes[Math.floor(i / 3)], target: n }))
    const sim = new ForceSimulation()
    sim.setGraph(nodes, links)
    sim.tick()
    const t0 = performance.now()
    for (let i = 0; i < 5; i++) sim.tick()
    const per = (performance.now() - t0) / 5
    // L'ancienne boucle O(n²) prenait plusieurs centaines de ms ici.
    expect(per).toBeLessThan(60)
  })
})
