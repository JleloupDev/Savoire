// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// Dessin du graphe sur un <canvas>, camera et gestes.
//
// Le SVG d'avant creait un element par note et par lien, et React les
// recalculait tous a chaque image : au-dela de quelques centaines de notes,
// tout ramait. Ici un seul canvas, dessine par lots (un chemin par couleur),
// et seulement quand quelque chose bouge. React ne fait que la barre d'outils.
//
// Gestes : molette ou pincement pour zoomer (vers le pointeur), glisser le
// fond pour se deplacer, tirer une note pour la deplacer (le reste suit),
// clic ou toucher pour l'ouvrir (Ctrl/Cmd ou clic du milieu : nouvel onglet,
// si l'hote le permet), double-clic sur le fond pour tout recadrer. Survoler
// une note eclaire ses voisines et estompe le reste.

import { ForceSimulation, type ForceParams } from './simulation'
import type { GraphViewSet, ModelNode, ModelLink } from './graphModel'

export interface DisplayOptions {
  showArrows: boolean
  colorByFolder: boolean
  labelZoom: number
  nodeSize: number
  linkWidth: number
}

export interface GraphCanvasCallbacks {
  onOpen(node: ModelNode, newTab: boolean): void
}

interface Colors {
  node: string
  faint: string
  line: string
  text: string
  accent: string
  bg: string
  font: string
}

const MIN_K = 0.02
const MAX_K = 8

export class GraphCanvas {
  private readonly canvas: HTMLCanvasElement
  private readonly ctx: CanvasRenderingContext2D | null
  private readonly probe: HTMLSpanElement
  private w = 0
  private h = 0
  private dpr = 1
  private colors: Colors = { node: '#888', faint: '#aaa', line: '#999', text: '#444', accent: '#0d9488', bg: '#fff', font: 'sans-serif' }

  private readonly sim = new ForceSimulation<ModelNode>()
  private view: GraphViewSet = { nodes: [], links: [] }
  private display: DisplayOptions

  /** Camera : point du monde au centre de l'ecran, et zoom. */
  private cam = { x: 0, y: 0, k: 1 }
  private camGoal: { x: number; y: number; k: number } | null = null
  /** Recadrer tout seul tant que la personne n'a pas pris la main. */
  private follow = true

  private hover: ModelNode | null = null
  private activePath: string | null = null
  private pointers = new Map<number, { x: number; y: number }>()
  private drag: { node: ModelNode; x: number; y: number; moved: boolean; id: number } | null = null
  private pan: { x: number; y: number; cx: number; cy: number; id: number } | null = null
  private pinch: { d: number; k: number; wx: number; wy: number } | null = null

  private raf = 0
  private destroyed = false
  private readonly cleanups: Array<() => void> = []

  constructor(private readonly host: HTMLElement, display: DisplayOptions, private readonly cb: GraphCanvasCallbacks) {
    this.display = display
    this.canvas = document.createElement('canvas')
    this.canvas.style.cssText = 'display:block;width:100%;height:100%;touch-action:none;outline:none'
    this.canvas.tabIndex = 0
    this.canvas.setAttribute('aria-label', 'Graphe des notes')
    this.canvas.dataset.testid = 'graph-canvas'
    host.appendChild(this.canvas)
    this.probe = document.createElement('span')
    this.probe.style.cssText = 'position:absolute;visibility:hidden;pointer-events:none'
    host.appendChild(this.probe)

    let ctx: CanvasRenderingContext2D | null = null
    try { ctx = this.canvas.getContext('2d') } catch { ctx = null }
    this.ctx = ctx

    this.readColors()
    this.listen()
    this.resize()
  }

  // ── API ─────────────────────────────────────────────────────────────────────

  setView(view: GraphViewSet, opts: { fresh: boolean; refit: boolean }): void {
    this.view = view
    this.sim.setGraph(view.nodes, view.links)
    if (this.hover && !view.nodes.includes(this.hover)) this.hover = null
    if (opts.fresh) {
      this.sim.alpha = 1
      this.warmUp()
    } else {
      this.sim.reheat(0.25)
    }
    if (opts.refit || opts.fresh) { this.follow = true; this.fit(false) }
    this.schedule()
  }

  setActive(path: string | null): void {
    this.activePath = path
    this.schedule()
  }

  setDisplay(display: DisplayOptions): void {
    this.display = display
    this.schedule()
  }

  setForces(params: ForceParams): void {
    this.sim.params = { ...params }
    this.sim.reheat(0.6)
    this.schedule()
  }

  /** Relance la mise en place, depuis les positions actuelles. */
  reheat(): void {
    this.sim.reheat(1)
    this.follow = true
    this.schedule()
  }

  zoomBy(factor: number): void {
    this.follow = false
    const k = clamp((this.camGoal?.k ?? this.cam.k) * factor, MIN_K, MAX_K)
    this.camGoal = { x: this.cam.x, y: this.cam.y, k }
    this.schedule()
  }

  /** Cadre toutes les notes visibles. */
  fit(animate = true): void {
    const goal = this.fitGoal()
    if (!goal) return
    if (animate) this.camGoal = goal
    else { this.cam = goal; this.camGoal = null }
    this.schedule()
  }

  /** Amene une note au centre, un peu zoomee. */
  focus(node: ModelNode): void {
    this.follow = false
    this.camGoal = { x: node.x, y: node.y, k: Math.max(this.cam.k, 1.5) }
    this.hover = node
    this.schedule()
  }

  destroy(): void {
    this.destroyed = true
    if (this.raf) cancelAnimationFrame(this.raf)
    for (const c of this.cleanups) c()
    this.canvas.remove()
    this.probe.remove()
  }

  // ── Boucle ──────────────────────────────────────────────────────────────────

  private schedule(): void {
    if (this.destroyed || !this.ctx || this.raf) return
    this.raf = requestAnimationFrame(() => this.frame())
  }

  private frame(): void {
    this.raf = 0
    let again = false

    if (this.sim.active && this.view.nodes.length) {
      // Petit graphe : plusieurs pas par image, il se pose plus vite.
      const t0 = performance.now()
      let steps = 0
      do { this.sim.tick(); steps++ } while (steps < 4 && performance.now() - t0 < 6)
      again = true
      if (this.follow) {
        const goal = this.fitGoal()
        if (goal) this.camGoal = goal
      }
    }

    if (this.camGoal) {
      const g = this.camGoal
      const t = 0.18
      this.cam.x += (g.x - this.cam.x) * t
      this.cam.y += (g.y - this.cam.y) * t
      this.cam.k *= Math.pow(g.k / this.cam.k, t)
      if (Math.abs(g.k / this.cam.k - 1) < 0.002 && Math.hypot(g.x - this.cam.x, g.y - this.cam.y) * this.cam.k < 0.5) {
        this.cam = { ...g }
        this.camGoal = null
      } else {
        again = true
      }
    }

    this.draw()
    if (again) this.schedule()
  }

  /** Premieres secondes de la mise en place, sans dessiner (50 ms au plus). */
  private warmUp(): void {
    const t0 = performance.now()
    for (let i = 0; i < 300 && performance.now() - t0 < 50; i++) this.sim.tick()
  }

  private fitGoal(): { x: number; y: number; k: number } | null {
    const nodes = this.view.nodes
    if (!nodes.length || !this.w || !this.h) return null
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
    for (const n of nodes) {
      if (n.x < x0) x0 = n.x
      if (n.x > x1) x1 = n.x
      if (n.y < y0) y0 = n.y
      if (n.y > y1) y1 = n.y
    }
    const pad = 40
    const bw = Math.max(x1 - x0, 1), bh = Math.max(y1 - y0, 1)
    const k = clamp(Math.min((this.w - pad * 2) / bw, (this.h - pad * 2) / bh), MIN_K, 1.6)
    return { x: (x0 + x1) / 2, y: (y0 + y1) / 2, k }
  }

  // ── Dessin ──────────────────────────────────────────────────────────────────

  private radius(n: ModelNode): number {
    return this.display.nodeSize * (4 + Math.sqrt(n.degree) * 1.7)
  }

  private draw(): void {
    const ctx = this.ctx
    if (!ctx || !this.w || !this.h) return
    const { k } = this.cam
    const ox = this.w / 2 - this.cam.x * k
    const oy = this.h / 2 - this.cam.y * k
    const dpr = this.dpr
    const c = this.colors
    const d = this.display

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, this.w, this.h)

    // Fenetre visible, dans le monde (avec une marge pour les gros points).
    const m = 40 / k
    const vx0 = -ox / k - m, vy0 = -oy / k - m
    const vx1 = (this.w - ox) / k + m, vy1 = (this.h - oy) / k + m
    const inView = (n: ModelNode) => n.x >= vx0 && n.x <= vx1 && n.y >= vy0 && n.y <= vy1
    const segInView = (l: ModelLink) => {
      const a = l.source, b = l.target
      return !((a.x < vx0 && b.x < vx0) || (a.x > vx1 && b.x > vx1) || (a.y < vy0 && b.y < vy0) || (a.y > vy1 && b.y > vy1))
    }

    const focus = this.drag?.node ?? this.hover
    const lit = focus ? new Set<ModelNode>([focus, ...focus.neighbors]) : null
    const active = this.activePath
    const isActive = (n: ModelNode) => n.path === active

    ctx.setTransform(dpr * k, 0, 0, dpr * k, dpr * ox, dpr * oy)

    // Liens : un trait pour tous, un autre pour ceux de la note survolee.
    ctx.lineWidth = Math.max(d.linkWidth, 0.6 / k)
    ctx.strokeStyle = c.line
    ctx.globalAlpha = lit ? 0.12 : 0.45
    ctx.beginPath()
    const hot: ModelLink[] = []
    for (const l of this.view.links) {
      if (!segInView(l)) continue
      if (focus && (l.source === focus || l.target === focus)) { hot.push(l); continue }
      ctx.moveTo(l.source.x, l.source.y)
      ctx.lineTo(l.target.x, l.target.y)
    }
    ctx.stroke()
    if (hot.length) {
      ctx.globalAlpha = 0.9
      ctx.strokeStyle = c.accent
      ctx.lineWidth = Math.max(d.linkWidth * 1.6, 1.2 / k)
      ctx.beginPath()
      for (const l of hot) { ctx.moveTo(l.source.x, l.source.y); ctx.lineTo(l.target.x, l.target.y) }
      ctx.stroke()
    }

    // Fleches, quand on est assez pres pour les voir.
    if (d.showArrows && k > 0.35) {
      ctx.fillStyle = c.line
      ctx.globalAlpha = lit ? 0.15 : 0.6
      ctx.beginPath()
      const size = Math.max(4 * d.linkWidth, 3 / k)
      for (const l of this.view.links) {
        if (!segInView(l)) continue
        const dx = l.target.x - l.source.x, dy = l.target.y - l.source.y
        const len = Math.hypot(dx, dy)
        const r = this.radius(l.target)
        if (len < r + size) continue
        const ux = dx / len, uy = dy / len
        const tx = l.target.x - ux * r, ty = l.target.y - uy * r
        ctx.moveTo(tx, ty)
        ctx.lineTo(tx - ux * size * 1.8 - uy * size, ty - uy * size * 1.8 + ux * size)
        ctx.lineTo(tx - ux * size * 1.8 + uy * size, ty - uy * size * 1.8 - ux * size)
        ctx.closePath()
      }
      ctx.fill()
    }

    // Notes, par couleur.
    const groups = new Map<string, ModelNode[]>()
    const dimmed = new Map<string, ModelNode[]>()
    const visible: ModelNode[] = []
    for (const n of this.view.nodes) {
      if (!inView(n)) continue
      visible.push(n)
      const col = isActive(n) || n === focus ? c.accent
        : n.attachment ? c.faint
        : (d.colorByFolder && n.color) || c.node
      const bucket = lit && !lit.has(n) ? dimmed : groups
      let list = bucket.get(col)
      if (!list) bucket.set(col, list = [])
      list.push(n)
    }
    const fillGroups = (g: Map<string, ModelNode[]>, alpha: number) => {
      ctx.globalAlpha = alpha
      for (const [col, list] of g) {
        ctx.fillStyle = col
        ctx.beginPath()
        for (const n of list) {
          const r = this.radius(n)
          // Point de moins de 2 px a l'ecran : un carre, bien moins cher
          // qu'un cercle et identique a l'oeil.
          if (r * k < 1.2) { ctx.rect(n.x - r, n.y - r, r * 2, r * 2); continue }
          ctx.moveTo(n.x + r, n.y)
          ctx.arc(n.x, n.y, r, 0, Math.PI * 2)
        }
        ctx.fill()
      }
    }
    fillGroups(dimmed, 0.2)
    fillGroups(groups, 1)

    // Anneau sur la note ouverte.
    const act = active ? this.view.nodes.find(isActive) : undefined
    if (act) {
      ctx.globalAlpha = 1
      ctx.strokeStyle = c.accent
      ctx.lineWidth = 2 / k
      ctx.beginPath()
      ctx.arc(act.x, act.y, this.radius(act) + 3 / k, 0, Math.PI * 2)
      ctx.stroke()
    }

    // Noms, a taille fixe a l'ecran. Ils apparaissent avec le zoom, plus tot
    // pour les notes tres reliees ; toujours pour la note survolee, ses
    // voisines et la note ouverte.
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.textAlign = 'center'
    ctx.textBaseline = 'top'
    const fontSize = 12
    ctx.font = `${fontSize}px ${c.font}`
    for (const n of visible) {
      let a: number
      if (n === focus || isActive(n)) a = 1
      else if (lit) a = lit.has(n) ? 1 : 0
      else a = clamp((k * (1 + Math.sqrt(n.degree) * 0.25) - d.labelZoom) / 0.35, 0, 1)
      if (a < 0.04) continue
      const sx = n.x * k + ox
      const sy = n.y * k + oy + this.radius(n) * k + 3
      const text = n.label.length > 40 ? n.label.slice(0, 38) + '…' : n.label
      ctx.globalAlpha = a
      if (n === focus) {
        ctx.font = `600 ${fontSize + 1}px ${c.font}`
        // Fond sous le nom survole : lisible meme au milieu des traits.
        const tw = ctx.measureText(text).width
        ctx.fillStyle = c.bg
        ctx.globalAlpha = 0.85
        ctx.fillRect(sx - tw / 2 - 4, sy - 2, tw + 8, fontSize + 6)
        ctx.globalAlpha = 1
        ctx.fillStyle = c.accent
        ctx.fillText(text, sx, sy)
        ctx.font = `${fontSize}px ${c.font}`
      } else {
        ctx.fillStyle = c.text
        ctx.fillText(text, sx, sy)
      }
    }
    ctx.globalAlpha = 1
  }

  // ── Gestes ──────────────────────────────────────────────────────────────────

  private toWorld(sx: number, sy: number): { x: number; y: number } {
    const { k } = this.cam
    return { x: (sx - this.w / 2) / k + this.cam.x, y: (sy - this.h / 2) / k + this.cam.y }
  }

  private local(e: { clientX: number; clientY: number }): { x: number; y: number } {
    const r = this.canvas.getBoundingClientRect()
    return { x: e.clientX - r.left, y: e.clientY - r.top }
  }

  private hit(sx: number, sy: number): ModelNode | null {
    const p = this.toWorld(sx, sy)
    const slack = 4 / this.cam.k
    let best: ModelNode | null = null
    let bestD = Infinity
    for (const n of this.view.nodes) {
      const r = Math.max(this.radius(n), 6 / this.cam.k) + slack
      const dx = n.x - p.x, dy = n.y - p.y
      const d2 = dx * dx + dy * dy
      if (d2 <= r * r && d2 < bestD) { best = n; bestD = d2 }
    }
    return best
  }

  private zoomAt(sx: number, sy: number, k: number): void {
    k = clamp(k, MIN_K, MAX_K)
    const before = this.toWorld(sx, sy)
    this.cam.k = k
    const after = this.toWorld(sx, sy)
    this.cam.x += before.x - after.x
    this.cam.y += before.y - after.y
  }

  private takeOver(): void {
    this.follow = false
    this.camGoal = null
  }

  private listen(): void {
    const cv = this.canvas
    const on = <K extends keyof HTMLElementEventMap>(type: K, fn: (e: HTMLElementEventMap[K]) => void, opts?: AddEventListenerOptions) => {
      cv.addEventListener(type, fn as EventListener, opts)
      this.cleanups.push(() => cv.removeEventListener(type, fn as EventListener, opts))
    }

    on('pointerdown', e => {
      const p = this.local(e)
      this.pointers.set(e.pointerId, p)
      try { cv.setPointerCapture(e.pointerId) } catch { /* pointeur deja relache */ }
      cv.focus({ preventScroll: true })
      if (this.pointers.size === 2) {
        // Deuxieme doigt : on passe au pincement.
        this.releaseDrag()
        this.pan = null
        const [a, b] = [...this.pointers.values()]
        const mid = this.toWorld((a.x + b.x) / 2, (a.y + b.y) / 2)
        this.pinch = { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, k: this.cam.k, wx: mid.x, wy: mid.y }
        this.takeOver()
        return
      }
      if (this.pointers.size > 2) return
      const n = this.hit(p.x, p.y)
      if (n) {
        this.drag = { node: n, x: p.x, y: p.y, moved: false, id: e.pointerId }
        this.hover = n
      } else {
        this.pan = { x: p.x, y: p.y, cx: this.cam.x, cy: this.cam.y, id: e.pointerId }
        cv.style.cursor = 'grabbing'
      }
      this.schedule()
    })

    on('pointermove', e => {
      const p = this.local(e)
      if (this.pointers.has(e.pointerId)) this.pointers.set(e.pointerId, p)

      if (this.pinch && this.pointers.size >= 2) {
        const [a, b] = [...this.pointers.values()]
        const dist = Math.hypot(a.x - b.x, a.y - b.y) || 1
        const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2
        this.cam.k = clamp(this.pinch.k * (dist / this.pinch.d), MIN_K, MAX_K)
        // Le point du monde pince reste sous les doigts.
        this.cam.x = this.pinch.wx - (mx - this.w / 2) / this.cam.k
        this.cam.y = this.pinch.wy - (my - this.h / 2) / this.cam.k
        this.schedule()
        return
      }

      if (this.drag && e.pointerId === this.drag.id) {
        const dr = this.drag
        if (!dr.moved && Math.hypot(p.x - dr.x, p.y - dr.y) < 4) return
        if (!dr.moved) {
          dr.moved = true
          this.takeOver()
          this.sim.alphaTarget = 0.3
          this.sim.reheat(0.3)
        }
        const w = this.toWorld(p.x, p.y)
        dr.node.fx = w.x
        dr.node.fy = w.y
        this.schedule()
        return
      }

      if (this.pan && e.pointerId === this.pan.id) {
        if (Math.hypot(p.x - this.pan.x, p.y - this.pan.y) > 2) this.takeOver()
        this.cam.x = this.pan.cx - (p.x - this.pan.x) / this.cam.k
        this.cam.y = this.pan.cy - (p.y - this.pan.y) / this.cam.k
        this.schedule()
        return
      }

      if (e.pointerType === 'mouse') {
        const n = this.hit(p.x, p.y)
        if (n !== this.hover) {
          this.hover = n
          cv.style.cursor = n ? 'pointer' : 'grab'
          cv.title = n ? n.path : ''
          this.schedule()
        }
      }
    })

    const end = (e: PointerEvent, cancelled: boolean) => {
      this.pointers.delete(e.pointerId)
      if (this.pinch) {
        if (this.pointers.size < 2) this.pinch = null
        return
      }
      const dr = this.drag
      if (dr && e.pointerId === dr.id) {
        const open = !dr.moved && !cancelled
        this.releaseDrag()
        if (e.pointerType !== 'mouse') this.hover = null
        if (open) this.cb.onOpen(dr.node, e.ctrlKey || e.metaKey || e.button === 1)
      }
      if (this.pan && e.pointerId === this.pan.id) {
        this.pan = null
        cv.style.cursor = this.hover ? 'pointer' : 'grab'
      }
      this.schedule()
    }
    on('pointerup', e => end(e, false))
    on('pointercancel', e => end(e, true))
    on('pointerleave', e => {
      if (e.pointerType === 'mouse' && !this.drag && this.hover) { this.hover = null; this.schedule() }
    })

    on('wheel', e => {
      e.preventDefault()
      this.takeOver()
      const p = this.local(e)
      const unit = e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? 400 : 1
      // Ctrl + molette : le pincement des pavés tactiles.
      const speed = e.ctrlKey ? 0.01 : 0.0015
      this.zoomAt(p.x, p.y, this.cam.k * Math.exp(-e.deltaY * unit * speed))
      this.schedule()
    }, { passive: false })

    on('dblclick', e => {
      const p = this.local(e)
      if (!this.hit(p.x, p.y)) { this.follow = true; this.fit(true) }
    })

    on('keydown', e => {
      const step = 60 / this.cam.k
      switch (e.key) {
        case '+': case '=': this.zoomBy(1.25); break
        case '-': case '_': this.zoomBy(0.8); break
        case '0': this.follow = true; this.fit(true); break
        case 'ArrowLeft': this.takeOver(); this.cam.x -= step; break
        case 'ArrowRight': this.takeOver(); this.cam.x += step; break
        case 'ArrowUp': this.takeOver(); this.cam.y -= step; break
        case 'ArrowDown': this.takeOver(); this.cam.y += step; break
        default: return
      }
      e.preventDefault()
      this.schedule()
    })

    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(() => this.resize())
      ro.observe(this.host)
      this.cleanups.push(() => ro.disconnect())
    }

    // Changement de theme : on relit les couleurs.
    if (typeof MutationObserver !== 'undefined') {
      const mo = new MutationObserver(() => { this.readColors(); this.schedule() })
      for (const el of [document.documentElement, document.body]) {
        if (el) mo.observe(el, { attributes: true, attributeFilter: ['class', 'style', 'data-theme'] })
      }
      this.cleanups.push(() => mo.disconnect())
    }
  }

  private releaseDrag(): void {
    if (!this.drag) return
    this.drag.node.fx = null
    this.drag.node.fy = null
    this.drag = null
    this.sim.alphaTarget = 0
    this.schedule()
  }

  private resize(): void {
    const r = this.host.getBoundingClientRect()
    const w = Math.round(r.width), h = Math.round(r.height)
    if (w === this.w && h === this.h) return
    const first = !this.w || !this.h
    this.w = w
    this.h = h
    this.dpr = Math.min(typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1, 2)
    this.canvas.width = Math.max(1, Math.round(w * this.dpr))
    this.canvas.height = Math.max(1, Math.round(h * this.dpr))
    if (first || this.follow) this.fit(false)
    this.schedule()
  }

  private readColors(): void {
    if (typeof getComputedStyle === 'undefined') return
    const read = (v: string, fallback: string) => {
      this.probe.style.color = ''
      this.probe.style.color = `var(${v}, ${fallback})`
      return getComputedStyle(this.probe).color || fallback
    }
    this.colors = {
      node: read('--text-muted', '#888'),
      faint: read('--text-faint', '#aaa'),
      line: read('--text-faint', '#999'),
      text: read('--text', '#333'),
      accent: read('--accent', '#0d9488'),
      bg: read('--bg-base', '#fff'),
      font: getComputedStyle(this.host).fontFamily || 'sans-serif',
    }
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}
