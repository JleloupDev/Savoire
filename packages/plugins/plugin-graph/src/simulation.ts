// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// Simulation de forces du graphe, sans dependance.
//
// Meme modele que d3-force (celui que suivent Obsidian et la plupart des
// graphes de notes) :
//  - repulsion entre toutes les notes, approchee par un quadtree
//    (Barnes-Hut) : O(n log n) au lieu de O(n²), ce qui rend 5 000 notes
//    possibles la ou l'ancienne boucle double s'effondrait vers 500 ;
//  - ressort sur chaque lien, plus faible entre deux notes tres reliees ;
//  - rappel vers le centre, sur x et sur y, qui garde les ilots et les
//    notes isolees dans le champ ;
//  - un « alpha » qui refroidit : la simulation s'arrete d'elle-meme quand
//    le dessin est stable, et se rechauffe quand on tire une note.

export interface SimNode {
  x: number
  y: number
  vx: number
  vy: number
  /** Position imposee (note tiree a la souris), ou null. */
  fx: number | null
  fy: number | null
}

export interface SimLink<N extends SimNode = SimNode> {
  source: N
  target: N
}

export interface ForceParams {
  /** Repulsion entre notes (positive). */
  repulsion: number
  /** Longueur de repos d'un lien. */
  linkDistance: number
  /** Raideur des liens, multiplie la raideur de base (0 a 2). */
  linkStrength: number
  /** Rappel vers le centre (0 a 1). */
  center: number
}

export const DEFAULT_FORCES: ForceParams = {
  repulsion: 180,
  linkDistance: 60,
  linkStrength: 1,
  center: 0.06,
}

// Precision de l'approximation : theta = 0.9 comme d3 ; un peu plus large
// sur un gros graphe, ou la difference ne se voit pas et le pas coute moins.
const THETA2 = 0.81
const THETA2_LARGE = 1.44
const LARGE = 1500
const DISTANCE_MIN2 = 1
const DISTANCE_MAX2 = 1600 * 1600

// ── Quadtree (Barnes-Hut) ─────────────────────────────────────────────────────

interface Quad {
  x0: number
  y0: number
  size: number
  /** Centre de masse et masse (nombre de notes) du carre. */
  cx: number
  cy: number
  mass: number
  /** Feuille : la ou les notes (plusieurs si elles sont confondues). */
  body: SimNode | null
  more: SimNode[] | null
  children: (Quad | null)[] | null
}

function newQuad(x0: number, y0: number, size: number): Quad {
  return { x0, y0, size, cx: 0, cy: 0, mass: 0, body: null, more: null, children: null }
}

function childIndex(q: Quad, x: number, y: number): number {
  const h = q.size / 2
  return (x >= q.x0 + h ? 1 : 0) + (y >= q.y0 + h ? 2 : 0)
}

function childQuad(q: Quad, i: number): Quad {
  const h = q.size / 2
  return newQuad(q.x0 + (i & 1 ? h : 0), q.y0 + (i & 2 ? h : 0), h)
}

function insert(q: Quad, n: SimNode, depth: number): void {
  for (;;) {
    if (q.children) {
      const i = childIndex(q, n.x, n.y)
      q = q.children[i] ?? (q.children[i] = childQuad(q, i))
      depth++
      continue
    }
    if (!q.body) { q.body = n; return }
    // Deux notes au meme endroit, ou carre trop petit : on les garde ensemble.
    if (depth > 40 || (q.body.x === n.x && q.body.y === n.y)) {
      ;(q.more ??= []).push(n)
      return
    }
    // Feuille occupee : on la divise et on y redescend l'occupant.
    const old = q.body
    q.body = null
    q.children = [null, null, null, null]
    const i = childIndex(q, old.x, old.y)
    const c = (q.children[i] = childQuad(q, i))
    c.body = old
    if (q.more) { c.more = q.more; q.more = null }
  }
}

function accumulate(q: Quad): void {
  if (q.children) {
    let m = 0, sx = 0, sy = 0
    for (const c of q.children) {
      if (!c) continue
      accumulate(c)
      m += c.mass; sx += c.cx * c.mass; sy += c.cy * c.mass
    }
    q.mass = m; q.cx = sx / m; q.cy = sy / m
  } else if (q.body) {
    const k = 1 + (q.more?.length ?? 0)
    q.mass = k; q.cx = q.body.x; q.cy = q.body.y
  }
}

function buildTree(nodes: SimNode[]): Quad | null {
  if (nodes.length === 0) return null
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (const n of nodes) {
    if (n.x < x0) x0 = n.x
    if (n.y < y0) y0 = n.y
    if (n.x > x1) x1 = n.x
    if (n.y > y1) y1 = n.y
  }
  const size = Math.max(x1 - x0, y1 - y0, 1) * 1.0001
  const root = newQuad(x0, y0, size)
  for (const n of nodes) insert(root, n, 0)
  accumulate(root)
  return root
}

// Petit bruit deterministe : separe deux notes confondues sans Math.random
// (un dessin reproductible d'une ouverture a l'autre).
let jiggleSeed = 1
function jiggle(): number {
  jiggleSeed = (jiggleSeed * 1664525 + 1013904223) >>> 0
  return ((jiggleSeed / 0xffffffff) - 0.5) * 1e-6
}

function applyRepulsion(root: Quad, n: SimNode, strength: number, theta2: number, stack: Quad[]): void {
  // Pile explicite, reutilisee d'une note a l'autre : pas de recursion ni
  // d'allocation par note.
  stack.length = 0
  stack.push(root)
  while (stack.length) {
    const q = stack.pop()!
    if (q.mass === 0) continue
    const dx = q.cx - n.x
    const dy = q.cy - n.y
    let l = dx * dx + dy * dy
    // Assez loin : tout le carre compte comme une seule masse.
    if (q.children) {
      if ((q.size * q.size) / theta2 < l) {
        if (l < DISTANCE_MAX2) {
          if (l < DISTANCE_MIN2) l = Math.sqrt(DISTANCE_MIN2 * l)
          const f = (strength * q.mass) / l
          n.vx += dx * f
          n.vy += dy * f
        }
      } else {
        const c = q.children
        if (c[0]) stack.push(c[0])
        if (c[1]) stack.push(c[1])
        if (c[2]) stack.push(c[2])
        if (c[3]) stack.push(c[3])
      }
      continue
    }
    // Feuille : note par note.
    repelFrom(n, q.body!, strength)
    if (q.more) for (const b of q.more) repelFrom(n, b, strength)
  }
}

function repelFrom(n: SimNode, b: SimNode, strength: number): void {
  if (b === n) return
  let dx = b.x - n.x
  let dy = b.y - n.y
  let l = dx * dx + dy * dy
  if (l >= DISTANCE_MAX2) return
  if (dx === 0) { dx = jiggle(); l += dx * dx }
  if (dy === 0) { dy = jiggle(); l += dy * dy }
  if (l < DISTANCE_MIN2) l = Math.sqrt(DISTANCE_MIN2 * l)
  const f = strength / l
  n.vx += dx * f
  n.vy += dy * f
}

// ── Simulation ────────────────────────────────────────────────────────────────

export class ForceSimulation<N extends SimNode = SimNode> {
  alpha = 1
  alphaTarget = 0
  readonly alphaMin = 0.002
  /** ~300 pas pour refroidir, comme d3. */
  readonly alphaDecay = 1 - Math.pow(0.002, 1 / 300)
  readonly velocityDecay = 0.4

  private nodes: N[] = []
  private links: SimLink<N>[] = []
  private strengths: Float64Array = new Float64Array(0)
  private biases: Float64Array = new Float64Array(0)

  constructor(public params: ForceParams = { ...DEFAULT_FORCES }) {}

  setGraph(nodes: N[], links: SimLink<N>[]): void {
    this.nodes = nodes
    this.links = links
    // Raideur et partage du deplacement selon le nombre de liens de chaque
    // bout (d3) : un lien vers un hub tire surtout la petite note.
    const count = new Map<N, number>()
    for (const l of links) {
      count.set(l.source, (count.get(l.source) ?? 0) + 1)
      count.set(l.target, (count.get(l.target) ?? 0) + 1)
    }
    this.strengths = new Float64Array(links.length)
    this.biases = new Float64Array(links.length)
    links.forEach((l, i) => {
      const s = count.get(l.source)!, t = count.get(l.target)!
      this.strengths[i] = 1 / Math.min(s, t)
      this.biases[i] = s / (s + t)
    })
  }

  /** Vrai tant que le dessin bouge encore. */
  get active(): boolean {
    return this.alpha >= this.alphaMin || this.alphaTarget > 0
  }

  reheat(alpha = 0.3): void {
    this.alpha = Math.max(this.alpha, alpha)
  }

  tick(cx = 0, cy = 0): void {
    const { nodes, links, params } = this
    this.alpha += (this.alphaTarget - this.alpha) * this.alphaDecay
    const alpha = this.alpha

    // Liens.
    const ks = params.linkStrength
    for (let i = 0; i < links.length; i++) {
      const { source: s, target: t } = links[i]
      let x = t.x + t.vx - s.x - s.vx || jiggle()
      let y = t.y + t.vy - s.y - s.vy || jiggle()
      let l = Math.sqrt(x * x + y * y)
      l = ((l - params.linkDistance) / l) * alpha * this.strengths[i] * ks
      x *= l; y *= l
      const b = this.biases[i]
      t.vx -= x * b; t.vy -= y * b
      s.vx += x * (1 - b); s.vy += y * (1 - b)
    }

    // Repulsion.
    const root = buildTree(nodes)
    if (root) {
      const strength = -params.repulsion * alpha
      const theta2 = nodes.length > LARGE ? THETA2_LARGE : THETA2
      const stack: Quad[] = []
      for (const n of nodes) applyRepulsion(root, n, strength, theta2, stack)
    }

    // Centre, puis integration.
    const kc = params.center * alpha
    const keep = 1 - this.velocityDecay
    for (const n of nodes) {
      n.vx += (cx - n.x) * kc
      n.vy += (cy - n.y) * kc
      if (n.fx !== null) { n.x = n.fx; n.vx = 0 } else { n.vx *= keep; n.x += n.vx }
      if (n.fy !== null) { n.y = n.fy; n.vy = 0 } else { n.vy *= keep; n.y += n.vy }
    }
  }
}

/**
 * Position de depart d'une note neuve : la spirale de d3 (phyllotaxie),
 * qui repartit n notes sans les empiler.
 */
export function spiralPosition(i: number, radius = 10): { x: number; y: number } {
  const r = radius * Math.sqrt(0.5 + i)
  const a = i * Math.PI * (3 - Math.sqrt(5))
  return { x: r * Math.cos(a), y: r * Math.sin(a) }
}
