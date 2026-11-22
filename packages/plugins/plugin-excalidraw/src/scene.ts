// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Modifier une scene Excalidraw sans Excalidraw (outils d'agent, ADR-033) :
// fabriquer des elements, les relier par des fleches attachees, les
// deplacer, les supprimer, placer un schema tout seul.
//
// Fonctions pures sur des SceneElement. Le resultat est un ScenePatch
// (binding.ts) : applique tout de suite a l'arbre du dessin, ou propose dans
// la Revision. Aucun import d'Excalidraw : ce code tourne aussi sur le pair
// indexeur, pour ChatGPT et Claude.
//
// Ce qu'Excalidraw attend, et qu'on respecte ici :
//  - un texte dans une forme est un element 'text' a part, `containerId` =
//    la forme, et la forme le cite dans `boundElements` ;
//  - une fleche attachee porte `startBinding` / `endBinding` ({ elementId,
//    focus, gap }) et chaque forme visee la cite dans `boundElements` : quand
//    on deplace la forme a la main, la fleche suit ;
//  - les points d'une fleche sont relatifs a son (x, y).
import type { SceneElement, ScenePatch } from './binding'

export const SHAPES = ['rectangle', 'ellipse', 'diamond', 'text', 'arrow', 'line'] as const
export type ShapeType = typeof SHAPES[number]
export const STROKE_STYLES = ['solid', 'dashed', 'dotted'] as const
export type StrokeStyle = typeof STROKE_STYLES[number]
export const NODE_SHAPES = ['rectangle', 'ellipse', 'diamond'] as const
export type NodeShape = typeof NODE_SHAPES[number]

export interface ShapeInput {
  type: ShapeType
  x: number
  y: number
  width?: number
  height?: number
  text?: string
  /** Couleur du trait (et du texte) : #rrggbb ou un nom (rouge, bleu...). */
  color?: string
  /** Couleur de fond d'une forme : #rrggbb, un nom, ou transparent. */
  fill?: string
  style?: StrokeStyle
  fontSize?: number
}

export const FONT_SIZE = 20
const LINE_HEIGHT = 1.25
/** Ecart entre le bout d'une fleche attachee et sa forme. */
const GAP = 8
const INK = '#1e1e1e'

// Palette d'Excalidraw : traits francs, fonds clairs.
const STROKE_NAMES: Record<string, string> = {
  noir: INK, black: INK, rouge: '#e03131', red: '#e03131', vert: '#2f9e44', green: '#2f9e44',
  bleu: '#1971c2', blue: '#1971c2', orange: '#f08c00', jaune: '#e67700', yellow: '#e67700',
  violet: '#9c36b5', purple: '#9c36b5', rose: '#c2255c', pink: '#c2255c', gris: '#868e96', gray: '#868e96', grey: '#868e96',
}
const FILL_NAMES: Record<string, string> = {
  transparent: 'transparent', aucun: 'transparent', none: 'transparent',
  rouge: '#ffc9c9', red: '#ffc9c9', vert: '#b2f2bb', green: '#b2f2bb', bleu: '#a5d8ff', blue: '#a5d8ff',
  jaune: '#ffec99', yellow: '#ffec99', orange: '#ffd8a8', violet: '#eebefa', purple: '#eebefa',
  rose: '#fcc2d7', pink: '#fcc2d7', gris: '#e9ecef', gray: '#e9ecef', grey: '#e9ecef', blanc: '#ffffff', white: '#ffffff',
}

const HEX = /^#[0-9a-f]{3,8}$/i

/** Une couleur de trait reconnue, sinon undefined (couleur par defaut). */
export function strokeColorOf(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined
  const s = v.trim().toLowerCase()
  return HEX.test(s) ? s : STROKE_NAMES[s]
}

/** Une couleur de fond reconnue, sinon undefined. */
export function fillColorOf(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined
  const s = v.trim().toLowerCase()
  return HEX.test(s) ? s : FILL_NAMES[s]
}

const randomInt = (): number => Math.floor(Math.random() * 2 ** 31)
export const newId = (): string => Math.random().toString(36).slice(2, 12) + Math.random().toString(36).slice(2, 12)

/** Taille approchee d'un texte (Excalidraw la recalcule a l'ouverture). */
export function measureText(text: string, fontSize = FONT_SIZE): { width: number; height: number } {
  const lines = text.split('\n')
  return {
    width: Math.max(1, ...lines.map(l => [...l].length)) * fontSize * 0.55,
    height: lines.length * fontSize * LINE_HEIGHT,
  }
}

function base(type: string, x: number, y: number, width: number, height: number, color: string): SceneElement {
  return {
    id: newId(), type, x, y, width, height, angle: 0,
    strokeColor: color, backgroundColor: 'transparent', fillStyle: 'solid', strokeWidth: 2, strokeStyle: 'solid',
    roughness: 1, opacity: 100, groupIds: [], frameId: null, roundness: type === 'rectangle' ? { type: 3 } : null,
    seed: randomInt(), version: 1, versionNonce: randomInt(), isDeleted: false, boundElements: null,
    updated: Date.now(), link: null, locked: false,
  }
}

/** Un element texte ; dans un conteneur, (x, y) est le centre du texte. */
export function textElement(text: string, x: number, y: number, color: string, containerId: string | null, fontSize = FONT_SIZE): SceneElement {
  const { width, height } = measureText(text, fontSize)
  return {
    ...base('text', containerId ? x - width / 2 : x, containerId ? y - height / 2 : y, width, height, color),
    text, originalText: text, fontSize, fontFamily: 1, lineHeight: LINE_HEIGHT, baseline: Math.round(fontSize * 0.9),
    textAlign: containerId ? 'center' : 'left', verticalAlign: containerId ? 'middle' : 'top', containerId, autoResize: true,
  }
}

const isLinear = (e: SceneElement): boolean => e.type === 'arrow' || e.type === 'line'
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
const fontSizeOf = (v: unknown): number => (typeof v === 'number' && v >= 8 && v <= 120 ? v : FONT_SIZE)

/** Les elements Excalidraw d'une forme (une forme et son texte, s'il y en a). */
export function shapeElements(s: ShapeInput): SceneElement[] {
  const color = strokeColorOf(s.color) ?? INK
  const text = s.text?.trim() ?? ''
  const fontSize = fontSizeOf(s.fontSize)
  if (s.type === 'text') return [textElement(text || ' ', s.x, s.y, color, null, fontSize)]
  const style = s.style && STROKE_STYLES.includes(s.style) ? s.style : 'solid'
  if (s.type === 'arrow' || s.type === 'line') {
    const width = s.width ?? 200
    const height = s.height ?? 0
    const line: SceneElement = {
      ...base(s.type, s.x, s.y, Math.abs(width), Math.abs(height), color), strokeStyle: style,
      points: [[0, 0], [width, height]], lastCommittedPoint: null, startBinding: null, endBinding: null,
      startArrowhead: null, endArrowhead: s.type === 'arrow' ? 'arrow' : null,
    }
    if (!text) return [line]
    const label = textElement(text, s.x + width / 2, s.y + height / 2, color, line.id, fontSize)
    return [{ ...line, boundElements: [{ type: 'text', id: label.id }] }, label]
  }
  const measured = text ? measureText(text, fontSize) : { width: 0, height: 0 }
  // Une forme trop petite pour son texte s'agrandit (un losange a besoin de plus de place).
  const room = s.type === 'rectangle' ? 1 : 1.5
  const width = Math.max(s.width ?? 160, measured.width * room + 20)
  const height = Math.max(s.height ?? 80, measured.height * room + 20)
  const fill = fillColorOf(s.fill)
  const shape: SceneElement = { ...base(s.type, s.x, s.y, width, height, color), strokeStyle: style, ...(fill ? { backgroundColor: fill } : {}) }
  if (!text) return [shape]
  const label = textElement(text, s.x + width / 2, s.y + height / 2, color, shape.id, fontSize)
  return [{ ...shape, boundElements: [{ type: 'text', id: label.id }] }, label]
}

// ── Geometrie ─────────────────────────────────────────────────────────────

interface Point { x: number; y: number }

export const centerOf = (e: SceneElement): Point => ({ x: num(e.x) + num(e.width) / 2, y: num(e.y) + num(e.height) / 2 })

/** Ou une fleche venant de `toward` touche le bord de la forme (plus l'ecart). */
export function edgePoint(e: SceneElement, toward: Point, gap = GAP): Point {
  const c = centerOf(e)
  const dx = toward.x - c.x
  const dy = toward.y - c.y
  const len = Math.hypot(dx, dy)
  if (len < 1e-6) return c
  const hw = Math.max(num(e.width) / 2, 1)
  const hh = Math.max(num(e.height) / 2, 1)
  let s: number
  if (e.type === 'ellipse') s = 1 / Math.sqrt((dx / hw) ** 2 + (dy / hh) ** 2)
  else if (e.type === 'diamond') s = 1 / (Math.abs(dx) / hw + Math.abs(dy) / hh)
  else s = Math.min(dx ? hw / Math.abs(dx) : Infinity, dy ? hh / Math.abs(dy) : Infinity)
  return { x: c.x + dx * s + (dx / len) * gap, y: c.y + dy * s + (dy / len) * gap }
}

type Points = [number, number][]
const pointsOf = (e: SceneElement): Points => (Array.isArray(e.points) && e.points.length >= 2 ? e.points as Points : [[0, 0], [num(e.width), num(e.height)]])

/** Debut et fin d'une fleche, en coordonnees de la scene. */
export function arrowEnds(e: SceneElement): { start: Point; end: Point } {
  const pts = pointsOf(e)
  const [sx, sy] = pts[0]!
  const [ex, ey] = pts[pts.length - 1]!
  return { start: { x: num(e.x) + sx, y: num(e.y) + sy }, end: { x: num(e.x) + ex, y: num(e.y) + ey } }
}

/** La fleche de `start` a `end` : droite, ou courbee de `bow` (un point au milieu, decale de cote). */
export function placeArrow(e: SceneElement, start: Point, end: Point, bow = 0): SceneElement {
  const dx = end.x - start.x
  const dy = end.y - start.y
  if (!bow) return { ...e, x: start.x, y: start.y, width: Math.abs(dx), height: Math.abs(dy), points: [[0, 0], [dx, dy]], roundness: null }
  const len = Math.hypot(dx, dy) || 1
  const mid: [number, number] = [dx / 2 - (dy / len) * bow, dy / 2 + (dx / len) * bow]
  const pts: Points = [[0, 0], mid, [dx, dy]]
  const xs = pts.map(p => p[0]), ys = pts.map(p => p[1])
  return {
    ...e, x: start.x, y: start.y, points: pts, roundness: { type: 2 },
    width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys),
  }
}

/** De combien une fleche a trois points est courbee (0 : droite). */
export function bowOf(e: SceneElement): number {
  const pts = pointsOf(e)
  if (pts.length !== 3) return 0
  const [[x0, y0], [x1, y1], [x2, y2]] = pts as [[number, number], [number, number], [number, number]]
  const dx = x2 - x0, dy = y2 - y0
  const len = Math.hypot(dx, dy)
  if (len < 1e-6) return 0
  // Distance signee du point du milieu a la corde.
  return ((x1 - (x0 + x2) / 2) * -dy + (y1 - (y0 + y2) / 2) * dx) / len
}

/** Le rectangle qui contient tout ce qui est visible. null : dessin vide. */
export function sceneBounds(elements: readonly SceneElement[]): { minX: number; minY: number; maxX: number; maxY: number } | null {
  let b: { minX: number; minY: number; maxX: number; maxY: number } | null = null
  const add = (x: number, y: number) => {
    if (!b) b = { minX: x, minY: y, maxX: x, maxY: y }
    else { b.minX = Math.min(b.minX, x); b.minY = Math.min(b.minY, y); b.maxX = Math.max(b.maxX, x); b.maxY = Math.max(b.maxY, y) }
  }
  for (const e of elements) {
    if (e.isDeleted) continue
    if (isLinear(e)) for (const [px, py] of pointsOf(e)) add(num(e.x) + px, num(e.y) + py)
    else { add(num(e.x), num(e.y)); add(num(e.x) + num(e.width), num(e.y) + num(e.height)) }
  }
  return b
}

// ── Brouillon de scene ────────────────────────────────────────────────────

type Bound = { type: string; id: string }
const boundOf = (e: SceneElement): Bound[] => (Array.isArray(e.boundElements) ? e.boundElements as Bound[] : [])
type Binding = { elementId: string; focus: number; gap: number }
const bindingOf = (v: unknown): Binding | null => (v && typeof v === 'object' && typeof (v as Binding).elementId === 'string' ? v as Binding : null)

/**
 * La scene en cours de modification : on lit, on change, et patch() rend les
 * elements changes avec leur version de depart (ScenePatch).
 */
export class SceneDraft {
  private readonly byId = new Map<string, SceneElement>()
  private readonly baseOf = new Map<string, { version: number; versionNonce: number } | null>()
  private readonly touched: string[] = []

  constructor(elements: readonly SceneElement[]) {
    for (const e of elements) this.byId.set(e.id, e)
  }

  /** Un element visible (pas supprime). */
  get(id: string): SceneElement | undefined {
    const e = this.byId.get(id)
    return e && !e.isDeleted ? e : undefined
  }

  /** Les elements visibles. */
  live(): SceneElement[] {
    return [...this.byId.values()].filter(e => !e.isDeleted)
  }

  /** Ajoute des elements neufs, dans l'ordre (le premier sous les suivants). */
  add(...elements: SceneElement[]): void {
    for (const e of elements) {
      this.byId.set(e.id, e)
      if (!this.baseOf.has(e.id)) { this.baseOf.set(e.id, null); this.touched.push(e.id) }
    }
  }

  /** Remplace un element par sa version modifiee. */
  set(e: SceneElement): void {
    const before = this.byId.get(e.id)
    if (!this.baseOf.has(e.id)) {
      this.baseOf.set(e.id, before ? { version: before.version, versionNonce: before.versionNonce } : null)
      this.touched.push(e.id)
    }
    this.byId.set(e.id, { ...e, updated: Date.now() })
  }

  private patchOne(id: string, change: Partial<SceneElement>): SceneElement | undefined {
    const e = this.byId.get(id)
    if (!e) return undefined
    const next = { ...e, ...change } as SceneElement
    this.set(next)
    return next
  }

  /** Ce qui a change, pret pour applyScenePatch ou la Revision. */
  patch(): ScenePatch {
    return {
      elements: this.touched.map(id => ({ ...this.byId.get(id)! })),
      base: Object.fromEntries(this.touched.map(id => [id, this.baseOf.get(id) ?? null])),
    }
  }

  /** Combien d'elements ajoutes, modifies, supprimes (sans les textes des formes). */
  counts(): { added: number; changed: number; removed: number } {
    let added = 0, changed = 0, removed = 0
    for (const id of this.touched) {
      const e = this.byId.get(id)!
      if (e.type === 'text' && typeof e.containerId === 'string') continue
      if (e.isDeleted) { if (this.baseOf.get(id)) removed++ }
      else if (this.baseOf.get(id) === null) added++
      else changed++
    }
    return { added, changed, removed }
  }

  // ── Textes ──

  /** Le texte pose dans une forme (ou sur une fleche). */
  labelOf(id: string): SceneElement | undefined {
    const e = this.get(id)
    if (!e) return undefined
    for (const b of boundOf(e)) {
      const t = b.type === 'text' ? this.get(b.id) : undefined
      if (t) return t
    }
    return undefined
  }

  /** Recentre le texte d'une forme (apres un deplacement ou un agrandissement). */
  private recenterLabel(container: SceneElement): void {
    const label = this.labelOf(container.id)
    if (!label) return
    const c = isLinear(container) ? midOf(container) : centerOf(container)
    this.patchOne(label.id, { x: c.x - num(label.width) / 2, y: c.y - num(label.height) / 2 })
  }

  /** Change (ou pose, ou retire avec '') le texte d'un element. */
  setText(id: string, text: string): void {
    const e = this.get(id)
    if (!e) return
    const value = text.trim()
    if (e.type === 'text') {
      if (!value) { this.remove(id); return }
      const size = measureText(value, fontSizeOf(e.fontSize))
      const next = this.patchOne(id, { text: value, originalText: value, ...size })!
      const container = typeof next.containerId === 'string' ? this.get(next.containerId) : undefined
      if (container) { this.fitToLabel(container, size); this.recenterLabel(this.get(container.id)!) }
      return
    }
    const label = this.labelOf(id)
    if (label) { this.setText(label.id, value); return }
    if (!value) return
    const c = isLinear(e) ? midOf(e) : centerOf(e)
    const t = textElement(value, c.x, c.y, String(e.strokeColor ?? INK), e.id)
    this.add(t)
    this.patchOne(id, { boundElements: [...boundOf(e), { type: 'text', id: t.id }] })
    if (!isLinear(e)) { this.fitToLabel(this.get(id)!, measureText(value)); this.recenterLabel(this.get(id)!) }
  }

  /** Une forme s'agrandit pour contenir son texte. */
  private fitToLabel(container: SceneElement, size: { width: number; height: number }): void {
    if (isLinear(container)) return
    const room = container.type === 'rectangle' ? 1 : 1.5
    const width = Math.max(num(container.width), size.width * room + 20)
    const height = Math.max(num(container.height), size.height * room + 20)
    if (width === container.width && height === container.height) return
    const c = centerOf(container)
    this.patchOne(container.id, { width, height, x: c.x - width / 2, y: c.y - height / 2 })
    this.rerouteArrowsOf(container.id)
  }

  // ── Fleches ──

  /** Les fleches attachees a cet element. */
  private arrowsOf(id: string): SceneElement[] {
    const out: SceneElement[] = []
    for (const e of this.live()) {
      if (!isLinear(e)) continue
      if (bindingOf(e.startBinding)?.elementId === id || bindingOf(e.endBinding)?.elementId === id) out.push(e)
    }
    return out
  }

  /** Redessine une fleche entre ses formes attachees (droite, de bord a bord). */
  private reroute(arrow: SceneElement): void {
    const from = bindingOf(arrow.startBinding) ? this.get(bindingOf(arrow.startBinding)!.elementId) : undefined
    const to = bindingOf(arrow.endBinding) ? this.get(bindingOf(arrow.endBinding)!.elementId) : undefined
    if (!from && !to) return
    const ends = arrowEnds(arrow)
    const start = from ? edgePoint(from, to ? centerOf(to) : ends.end) : ends.start
    const end = to ? edgePoint(to, from ? centerOf(from) : ends.start) : ends.end
    // Une fleche courbee (aller et retour entre deux formes) le reste.
    const placed = placeArrow(arrow, start, end, bowOf(arrow))
    this.set(placed)
    this.recenterLabel(placed)
  }

  /** Courbe une fleche de `bow` (0 : la redresse), sans la detacher. */
  bend(arrowId: string, bow: number): void {
    const arrow = this.get(arrowId)
    if (!arrow || !isLinear(arrow)) return
    const { start, end } = arrowEnds(arrow)
    const placed = placeArrow(arrow, start, end, bow)
    this.set(placed)
    this.recenterLabel(placed)
  }

  private rerouteArrowsOf(id: string): void {
    for (const a of this.arrowsOf(id)) this.reroute(a)
  }

  /** Attache (ou detache, avec null) un bout de fleche a une forme, et la redessine. */
  connect(arrowId: string, end: 'start' | 'end', targetId: string | null): void {
    const arrow = this.get(arrowId)
    if (!arrow || !isLinear(arrow)) throw new Error(`${arrowId} n'est pas une flèche.`)
    const key = end === 'start' ? 'startBinding' : 'endBinding'
    const old = bindingOf(arrow[key])
    if (old && old.elementId !== targetId) this.unbind(old.elementId, arrowId)
    if (targetId) {
      const target = this.get(targetId)
      if (!target) throw new Error(`Élément introuvable : ${targetId}.`)
      if (isLinear(target) || (target.type === 'text' && typeof target.containerId === 'string')) throw new Error(`On n'attache pas une flèche à ${targetId} (${String(target.type)}).`)
      if (!boundOf(target).some(b => b.id === arrowId)) this.patchOne(targetId, { boundElements: [...boundOf(target), { type: 'arrow', id: arrowId }] })
    }
    const next = this.patchOne(arrowId, { [key]: targetId ? { elementId: targetId, focus: 0, gap: GAP } : null })!
    this.reroute(next)
  }

  private unbind(shapeId: string, arrowId: string): void {
    const shape = this.byId.get(shapeId)
    if (!shape) return
    const kept = boundOf(shape).filter(b => b.id !== arrowId)
    if (kept.length !== boundOf(shape).length) this.patchOne(shapeId, { boundElements: kept.length ? kept : null })
  }

  // ── Deplacer, changer, supprimer ──

  /** Deplace ou redimensionne un element ; son texte et ses fleches suivent. */
  move(id: string, box: { x?: number; y?: number; width?: number; height?: number }): void {
    const e = this.get(id)
    if (!e) return
    if (isLinear(e)) {
      // Une fleche deplacee a la main n'est plus attachee.
      for (const k of ['startBinding', 'endBinding'] as const) {
        const b = bindingOf(e[k])
        if (b) this.unbind(b.elementId, id)
      }
      const ends = arrowEnds(e)
      const start = { x: box.x ?? ends.start.x, y: box.y ?? ends.start.y }
      const dx = box.width ?? ends.end.x - ends.start.x
      const dy = box.height ?? ends.end.y - ends.start.y
      const placed = placeArrow({ ...e, startBinding: null, endBinding: null }, start, { x: start.x + dx, y: start.y + dy })
      this.set(placed)
      this.recenterLabel(placed)
      return
    }
    const next = this.patchOne(id, {
      ...(box.x !== undefined ? { x: box.x } : {}), ...(box.y !== undefined ? { y: box.y } : {}),
      ...(box.width !== undefined ? { width: Math.max(1, box.width) } : {}), ...(box.height !== undefined ? { height: Math.max(1, box.height) } : {}),
    })!
    this.recenterLabel(next)
    this.rerouteArrowsOf(id)
  }

  /** Couleurs et trait d'un element (et de son texte). */
  restyle(id: string, s: { color?: string; fill?: string; style?: StrokeStyle }): void {
    const e = this.get(id)
    if (!e) return
    const color = strokeColorOf(s.color)
    const fill = fillColorOf(s.fill)
    this.patchOne(id, {
      ...(color ? { strokeColor: color } : {}),
      ...(fill && !isLinear(e) && e.type !== 'text' ? { backgroundColor: fill } : {}),
      ...(s.style && STROKE_STYLES.includes(s.style) ? { strokeStyle: s.style } : {}),
    })
    const label = color ? this.labelOf(id) : undefined
    if (label) this.patchOne(label.id, { strokeColor: color })
  }

  /** Supprime un element, son texte ; les fleches qui y etaient attachees restent, detachees. */
  remove(id: string): void {
    const e = this.get(id)
    if (!e) return
    if (e.type === 'text' && typeof e.containerId === 'string') {
      // Le texte seul : la forme le perd.
      const container = this.byId.get(e.containerId)
      if (container) {
        const kept = boundOf(container).filter(b => b.id !== id)
        this.patchOne(container.id, { boundElements: kept.length ? kept : null })
      }
      this.patchOne(id, { isDeleted: true })
      return
    }
    for (const b of boundOf(e)) if (b.type === 'text') this.patchOne(b.id, { isDeleted: true })
    if (isLinear(e)) {
      for (const k of ['startBinding', 'endBinding'] as const) {
        const b = bindingOf(e[k])
        if (b) this.unbind(b.elementId, id)
      }
    } else {
      for (const a of this.arrowsOf(id)) {
        this.patchOne(a.id, {
          ...(bindingOf(a.startBinding)?.elementId === id ? { startBinding: null } : {}),
          ...(bindingOf(a.endBinding)?.elementId === id ? { endBinding: null } : {}),
        })
      }
    }
    this.patchOne(id, { isDeleted: true })
  }
}

/** Le milieu d'une fleche (son point du milieu, si elle est courbee) : la ou va son texte. */
const midOf = (e: SceneElement): Point => {
  const pts = pointsOf(e)
  if (pts.length === 3) return { x: num(e.x) + pts[1]![0], y: num(e.y) + pts[1]![1] }
  const { start, end } = arrowEnds(e)
  return { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 }
}

// ── Schema place tout seul ────────────────────────────────────────────────

export interface DiagramNode { key: string; text: string; shape?: NodeShape; color?: string; fill?: string }
export interface DiagramEdge { from: string; to: string; text?: string; style?: StrokeStyle; color?: string }
export type DiagramDirection = 'right' | 'down'

const LAYER_GAP = 140
const NODE_GAP = 50

/** La taille d'un noeud : de quoi contenir son texte. */
export function nodeSize(n: Pick<DiagramNode, 'text' | 'shape'>): { width: number; height: number } {
  const t = measureText(n.text.trim() || ' ')
  const room = !n.shape || n.shape === 'rectangle' ? 1 : 1.5
  return { width: Math.max(140, t.width * room + 40), height: Math.max(64, t.height * room + 30) }
}

/**
 * Place les noeuds en couches (un noeud est apres ceux qui pointent vers lui),
 * de gauche a droite ou de haut en bas, en limitant les croisements. Rend le
 * coin haut-gauche et la taille de chaque noeud, a partir de `origin`.
 */
export function layoutDiagram(
  nodes: readonly Pick<DiagramNode, 'key' | 'text' | 'shape'>[],
  edges: readonly Pick<DiagramEdge, 'from' | 'to'>[],
  direction: DiagramDirection,
  origin: Point,
): Map<string, { x: number; y: number; width: number; height: number }> {
  const keys = nodes.map(n => n.key)
  const known = new Set(keys)
  const links = edges.filter(e => known.has(e.from) && known.has(e.to) && e.from !== e.to)
  const out = new Map<string, string[]>(keys.map(k => [k, []]))
  for (const e of links) out.get(e.from)!.push(e.to)

  // 1. Retirer les cycles : un lien vers un noeud en cours de visite est ignore pour les couches.
  const state = new Map<string, 1 | 2>()
  const kept: [string, string][] = []
  const visit = (k: string) => {
    state.set(k, 1)
    for (const to of out.get(k)!) {
      if (state.get(to) === 1) continue
      kept.push([k, to])
      if (!state.has(to)) visit(to)
    }
    state.set(k, 2)
  }
  for (const k of keys) if (!state.has(k)) visit(k)

  // 2. Couches : la plus longue chaine qui mene a chaque noeud.
  const preds = new Map<string, string[]>(keys.map(k => [k, []]))
  for (const [a, b] of kept) preds.get(b)!.push(a)
  const rank = new Map<string, number>()
  const rankOf = (k: string, seen = new Set<string>()): number => {
    const known = rank.get(k)
    if (known !== undefined) return known
    if (seen.has(k)) return 0
    seen.add(k)
    const r = Math.max(-1, ...preds.get(k)!.map(p => rankOf(p, seen))) + 1
    rank.set(k, r)
    return r
  }
  for (const k of keys) rankOf(k)
  const layers: string[][] = []
  for (const k of keys) (layers[rank.get(k)!] ??= []).push(k)

  // 3. Ordre dans chaque couche : au barycentre des voisins de la couche d'avant (deux passes).
  const posIn = (layer: string[]) => new Map(layer.map((k, i) => [k, i]))
  for (let pass = 0; pass < 2; pass++) {
    for (let r = 1; r < layers.length; r++) {
      const prev = posIn(layers[r - 1] ?? [])
      const bary = new Map((layers[r] ?? []).map((k, i) => {
        const ps = preds.get(k)!.map(p => prev.get(p)).filter((x): x is number => x !== undefined)
        return [k, ps.length ? ps.reduce((a, b) => a + b, 0) / ps.length : i] as const
      }))
      layers[r] = (layers[r] ?? []).slice().sort((a, b) => bary.get(a)! - bary.get(b)!)
    }
  }

  // 4. Coordonnees : couches a la suite, noeuds centres dans leur couche.
  const size = new Map(nodes.map(n => [n.key, nodeSize(n)]))
  const across = (k: string) => (direction === 'right' ? size.get(k)!.height : size.get(k)!.width)
  const along = (k: string) => (direction === 'right' ? size.get(k)!.width : size.get(k)!.height)
  const extent = (layer: string[]) => layer.reduce((s, k) => s + across(k), 0) + NODE_GAP * Math.max(0, layer.length - 1)
  const widest = Math.max(0, ...layers.map(l => extent(l ?? [])))
  const result = new Map<string, { x: number; y: number; width: number; height: number }>()
  let main = 0
  for (const layer of layers) {
    if (!layer?.length) continue
    const depth = Math.max(...layer.map(along))
    let side = (widest - extent(layer)) / 2
    for (const k of layer) {
      const s = size.get(k)!
      const offset = (depth - along(k)) / 2
      const [x, y] = direction === 'right' ? [main + offset, side] : [side, main + offset]
      result.set(k, { x: origin.x + x, y: origin.y + y, ...s })
      side += across(k) + NODE_GAP
    }
    main += depth + LAYER_GAP
  }
  return result
}

/** Ou poser du nouveau sans recouvrir l'existant : a droite de ce qui est dessine. */
export function freeSpot(elements: readonly SceneElement[]): Point {
  const b = sceneBounds(elements)
  return b ? { x: Math.round(b.maxX + 120), y: Math.round(b.minY) } : { x: 0, y: 0 }
}
