// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Voir ce que fait l'IA. Une modification d'un agent arrive un instant
// surlignee dans sa couleur, puis le surlignage s'efface en quelques
// secondes :
//  - le texte ajoute : un fond a la couleur de l'agent ;
//  - le texte supprime : une trace barree, a sa place, qui s'efface aussi ;
//  - dans la marge : un trait, visible dans tous les modes.
//
// Chaque zone est un point de l'historique (AiChanges, dans le CRDT de la
// note). Tant qu'elle se voit, la survoler ou la cliquer ouvre une petite
// carte : qui, pour qui, quoi, pourquoi, « Annuler » et « Historique ».
// Une fois effacee, la carte ne s'ouvre plus depuis le texte ; la liste du
// panneau Revision reste.
//
// Seuls les points qui viennent d'arriver sont montres : ni ceux deja la a
// l'ouverture de la note, ni les anciens, ni les points compactes.
//
// Le texte brut (mode source, ligne en cours d'edition) porte une decoration
// de CodeMirror. Le texte deja rendu (modes « power » et « classique » : un
// widget) est surligne par l'API des surlignages du navigateur
// (DomHighlights.ts). Cette API ne s'anime pas : le fondu avance par pas,
// dans une feuille de style reecrite a chaque pas. La trace d'une
// suppression est un widget : dans un bloc rendu elle ne se voit pas, il
// reste le trait dans la marge.
//
// L'editeur ne connait pas l'application : l'hote (AiChangeHost) dit qui est
// la personne, et sait montrer un point dans le panneau Revision.

import { StateEffect, StateField, type ChangeDesc, type EditorState, type Extension } from '@codemirror/state'
import { Decoration, EditorView, ViewPlugin, WidgetType, showTooltip, type DecorationSet, type Tooltip, type TooltipView, type ViewUpdate } from '@codemirror/view'
import type { AiChangeInfo, AiChangeRanges, AiChangeWho, ICRDT } from '@savoire/plugin-api'
import { renderedNeedle } from './AiMarks'
import { applyBlockMarks, type BlockMark } from './BlockMarks'
import { renderedTextRanges, setDomHighlight } from './DomHighlights'

/** Duree d'un surlignage, du plein a rien. */
export const AI_FLASH_MS = 5500
/** Un point plus vieux que cela n'est pas montre (note rouverte, retour de connexion). */
export const AI_FLASH_FRESH_MS = 30_000
/** Le surlignage reste plein un instant avant de s'effacer. */
const HOLD_MS = 900
/** Pas du fondu. */
const STEP_MS = 200
/** Les points ecrits avant l'ouverture de la note ne sont pas montres ; marge pour deux horloges qui different un peu. */
const LOAD_SLACK_MS = 2000
/** Surlignages montres a la fois ; les plus anciens partent. */
const MAX_FLASHES = 24
/** Longueur de la trace d'un texte supprime. */
const MAX_TRACE = 80
/** Textes supprimes montres dans la carte. */
const MAX_CARD_DELETED = 3
/** Tant que la carte est ouverte, le surlignage ne descend pas plus bas. */
const HELD_STRENGTH = 0.45
const HOVER_OPEN_MS = 250
const HOVER_CLOSE_MS = 400
/** Meme couleur que les agents sans couleur (YjsCrdtAdapter). */
const DEFAULT_COLOR = '#7c3aed'

/** Les points de la note (YjsCrdtAdapter : aiChanges, onAiChangesChange, aiChangeRanges, undoAiChange). */
export interface AiChangeFlashSource {
  /** Les points montres, le plus recent d'abord. */
  list(): AiChangeInfo[]
  /** `added` : les points ranges qui viennent d'apparaitre. */
  subscribe(cb: (added: string[]) => void): () => void
  /** Ou sont les traces de ces points, dans le texte du moment. */
  ranges(parts: readonly string[]): AiChangeRanges
  /** Annule ces points. Absent : pas de bouton « Annuler ». */
  undo?(parts: readonly string[], by: AiChangeWho): { ok: boolean; partial: boolean }
}

/** Ce que l'application apporte a la carte d'un point. */
export interface AiChangeHost {
  /** La personne qui annule (null : pas connue, pas de bouton « Annuler »). */
  me(): AiChangeWho | null
  /** Montre le point dans le panneau Revision. Absent : pas de bouton « Historique ». */
  showHistory?(docId: string, pointId: string): void
}

export interface AiChangeFlashOptions {
  /** Le document de cet editeur (pour « Historique »). */
  docId?: string
  /** Hote fixe ; un hote pose par setAiChangeHost l'emporte. */
  host?: AiChangeHost
}

/** Un surlignage en cours. */
interface Flash {
  /** Le point range. */
  id: string
  /** Numero unique dans la page : ses classes CSS et son surlignage du navigateur. */
  slot: number
  info: AiChangeInfo
  /** « #rrggbb ». */
  color: string
  startedAt: number
  inserted: readonly { from: number; to: number }[]
  deleted: readonly { at: number; text: string }[]
  /** Annule depuis la carte : plus de trace ; il part quand la carte se ferme. */
  done?: boolean
}

interface OpenCard {
  id: string
  pos: number
  /** Ouverte d'un clic : elle reste quand la souris s'en va. */
  pinned: boolean
  create: (view: EditorView) => TooltipView
}

interface FlashState {
  flashes: readonly Flash[]
  open: OpenCard | null
  host: AiChangeHost | null
  decorations: DecorationSet
}

const putFlashes = StateEffect.define<readonly Flash[]>()
const dropFlashes = StateEffect.define<readonly string[]>()
const doneFlash = StateEffect.define<string>()
const setCard = StateEffect.define<OpenCard | null>()
const setHost = StateEffect.define<AiChangeHost | null>()

/** Ce qu'on lit d'un texte supprime : une ligne, courte. */
function traceText(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  if (!flat) return text.includes('\n') ? '↵' : '␣'
  return flat.length > MAX_TRACE ? `${flat.slice(0, MAX_TRACE - 1).trimEnd()}…` : flat
}

class DeletedTrace extends WidgetType {
  constructor(private readonly id: string, private readonly slot: number, private readonly text: string, private readonly title: string) { super() }

  eq(other: DeletedTrace): boolean {
    return other.id === this.id && other.slot === this.slot && other.text === this.text
  }

  toDOM(): HTMLElement {
    const span = document.createElement('span')
    span.className = `cm-ai-flash-del cm-ai-flash-del-${this.slot}`
    span.dataset.aiChange = this.id
    span.setAttribute('data-testid', 'ai-flash-deleted')
    span.setAttribute('aria-label', this.title)
    span.textContent = traceText(this.text)
    return span
  }

  ignoreEvent(): boolean {
    return true
  }
}

const whoOf = (info: AiChangeInfo): string =>
  info.forUser ? `${info.agent.name} (IA), pour ${info.forUser.name}` : `${info.agent.name} (IA)`

function decorate(flashes: readonly Flash[]): DecorationSet {
  const out = []
  for (const f of flashes) {
    if (f.done) continue
    for (const r of f.inserted) {
      if (r.to <= r.from) continue
      out.push(Decoration.mark({ class: `cm-ai-flash cm-ai-flash-${f.slot}`, attributes: { 'data-ai-change': f.id } }).range(r.from, r.to))
    }
    for (const d of f.deleted) {
      out.push(Decoration.widget({ widget: new DeletedTrace(f.id, f.slot, d.text, `Supprimé par ${whoOf(f.info)}`), side: -1 }).range(d.at))
    }
  }
  return Decoration.set(out, true)
}

/** Les positions suivent le texte ; ce qu'on tape au bord d'un ajout n'y entre pas. */
function mapFlash(f: Flash, changes: ChangeDesc): Flash {
  return {
    ...f,
    inserted: f.inserted.map(r => {
      const from = changes.mapPos(r.from, 1)
      return { from, to: Math.max(from, changes.mapPos(r.to, -1)) }
    }),
    deleted: f.deleted.map(d => ({ ...d, at: changes.mapPos(d.at, -1) })),
  }
}

const field = StateField.define<FlashState>({
  create: () => ({ flashes: [], open: null, host: null, decorations: Decoration.none }),
  update(value, tr) {
    let { flashes, open, host } = value
    if (tr.docChanged) {
      if (flashes.length) flashes = flashes.map(f => mapFlash(f, tr.changes))
      if (open) open = { ...open, pos: tr.changes.mapPos(open.pos) }
    }
    for (const e of tr.effects) {
      if (e.is(putFlashes)) {
        const ids = new Set(e.value.map(f => f.id))
        flashes = [...flashes.filter(f => !ids.has(f.id)), ...e.value]
      } else if (e.is(dropFlashes)) {
        flashes = flashes.filter(f => !e.value.includes(f.id))
      } else if (e.is(doneFlash)) {
        flashes = flashes.map(f => (f.id === e.value ? { ...f, done: true } : f))
      } else if (e.is(setCard)) {
        open = e.value
      } else if (e.is(setHost)) {
        host = e.value
      }
    }
    // Un point annule ne reste que le temps de sa carte ; une carte sans point se ferme.
    if (flashes.some(f => f.done && open?.id !== f.id)) flashes = flashes.filter(f => !f.done || open?.id === f.id)
    if (open && !flashes.some(f => f.id === open!.id)) open = null
    if (flashes === value.flashes && open === value.open && host === value.host) return value
    return { flashes, open, host, decorations: flashes === value.flashes ? value.decorations : decorate(flashes) }
  },
  provide: f => [
    EditorView.decorations.from(f, v => v.decorations),
    showTooltip.compute([f], (state): Tooltip | null => {
      const open = state.field(f).open
      return open ? { pos: open.pos, above: false, create: open.create } : null
    }),
  ],
})

/** Un surlignage trouve sous la souris : par son texte brut (ou sa trace), par la marge, ou par le texte rendu. */
interface Hit {
  flash: Flash
  via: 'mark' | 'bar' | 'rendered'
}

/** Numeros des surlignages : uniques dans la page (un nom de surlignage du navigateur vaut pour toute la page). */
let nextSlot = 1

const highlightName = (slot: number): string => `plume-ai-flash-${slot}`
const markOwner = (id: string): string => `ai-flash:${id}`

function rgbOf(color: string | undefined): { hex: string; rgb: string } {
  let hex = /^#[0-9a-f]{6}$/i.test(color ?? '') ? color! : DEFAULT_COLOR
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(color ?? '')
  if (short) hex = `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`
  const n = parseInt(hex.slice(1), 16)
  return { hex, rgb: `${(n >> 16) & 255},${(n >> 8) & 255},${n & 255}` }
}

function reducedMotion(): boolean {
  try { return !!globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches } catch { return false }
}

/**
 * Force du surlignage (1 : plein, 0 : efface). Sans animation (reglage du
 * systeme) : plein jusqu'au bout, puis retire.
 */
export function aiFlashStrength(elapsed: number, held = false, reduced = false): number {
  if (reduced) return 1
  const p = Math.min(1, Math.max(0, (elapsed - HOLD_MS) / (AI_FLASH_MS - HOLD_MS)))
  return held ? Math.max(1 - p, HELD_STRENGTH) : 1 - p
}

/** Les regles CSS d'un surlignage, a cette force. */
function rules(f: Flash, k: number): string {
  const { rgb } = rgbOf(f.color)
  const a = (x: number): string => (x * k).toFixed(3)
  return [
    `.cm-ai-flash-${f.slot}{background-color:rgba(${rgb},${a(0.32)});box-shadow:inset 0 -2px 0 rgba(${rgb},${a(0.85)})}`,
    `.cm-content ::highlight(${highlightName(f.slot)}){background-color:rgba(${rgb},${a(0.32)})}`,
    `.cm-ai-flash-del-${f.slot}{color:rgb(${rgb});opacity:${k.toFixed(3)}}`,
    `.cm-block-mark-bar.cm-block-ai-flash-${f.slot}{opacity:${k.toFixed(3)}}`,
  ].join('\n')
}

/** L'endroit du texte rendu le plus proche de `hint` ou se lit `needle` (a partir de `min`). */
function nearest(hay: string, needle: string, hint: number, min: number): number {
  let best = -1
  for (let i = hay.indexOf(needle, min); i >= 0; i = hay.indexOf(needle, i + 1)) {
    if (best >= 0 && Math.abs(i - hint) >= Math.abs(best - hint)) break
    best = i
  }
  return best
}

/** Ce qu'un passage de Markdown donne a lire une fois rendu, en longueur (a peu pres). */
function renderedLength(source: string): number {
  return source.split('\n').reduce((n, line) => n + renderedNeedle(line).length, 0)
}

/**
 * Les plages du texte RENDU qui affichent ces passages du texte (comme
 * AiMarks : on cherche chaque ligne sans ses marques Markdown). Un mot
 * ajoute peut se lire plusieurs fois dans le bloc : on prend l'endroit le
 * plus proche de la ou il doit etre. Approximatif ; sinon, il reste le trait
 * dans la marge.
 */
function renderedRangesOf(view: EditorView, spans: readonly { from: number; to: number }[]): Range[] {
  if (!spans.length) return []
  const blocks = Array.from(view.contentDOM.children)
  const doc = view.state.doc
  return renderedTextRanges(view, (text, block) => {
    let start: number
    let end: number
    try {
      start = view.posAtDOM(block)
      const next = blocks[blocks.indexOf(block) + 1]
      end = next ? view.posAtDOM(next) : doc.length
    } catch { return [] }
    const found: [number, number][] = []
    for (const s of spans) {
      const a = Math.max(s.from, start)
      const b = Math.min(s.to, end)
      if (b <= a) continue
      let hint = renderedLength(doc.sliceString(start, a))
      let cursor = 0
      for (const line of doc.sliceString(a, b).split('\n')) {
        const needle = renderedNeedle(line)
        if (!needle) continue
        const at = nearest(text, needle, hint, cursor)
        if (at < 0) continue
        found.push([at, at + needle.length])
        cursor = at + needle.length
        hint = cursor
      }
    }
    return found
  })
}

const domHighlights = (): boolean => typeof CSS !== 'undefined' && !!CSS.highlights && typeof Highlight !== 'undefined'

const SUMMARY_FALLBACK = { added: 'Texte ajouté', removed: 'Texte supprimé', changed: 'Texte modifié' } as const

function summaryOf(info: AiChangeInfo): string {
  const said = [...new Set(info.summaries.map(s => s.trim()).filter(Boolean))].join(', ')
  if (said) return said.charAt(0).toUpperCase() + said.slice(1)
  if (info.inserted && info.deleted) return SUMMARY_FALLBACK.changed
  return info.deleted ? SUMMARY_FALLBACK.removed : SUMMARY_FALLBACK.added
}

export function aiChangeFlashExtension(source: AiChangeFlashSource, options: AiChangeFlashOptions = {}): Extension {
  const hostOf = (state: EditorState): AiChangeHost | null => state.field(field).host ?? options.host ?? null

  class FlashView {
    /** Les points ecrits avant ne sont pas montres : ils etaient deja la. */
    private readonly openedAt = Date.now()
    private readonly style: HTMLStyleElement
    private readonly unsubscribe: () => void
    private css = ''
    private pending: string[] = []
    private scheduled = false
    private tidying = false
    private destroyed = false
    private ticker: ReturnType<typeof setInterval> | null = null
    /** Ce qui est pose pour chaque surlignage (marge, surlignage du navigateur) : a retirer avec lui. */
    private shown = new Map<string, { slot: number; key: string }>()
    /** Le texte rendu de chaque surlignage : pour savoir si la souris est dessus. */
    private domRanges = new Map<string, Range[]>()
    /**
     * D'ou la carte a ete ouverte, pour la dessiner sous la souris. `dx` : ou
     * etait la souris dans le rectangle survole (de gauche a droite ; de haut
     * en bas pour la marge).
     */
    private anchor: { id: string; via: Hit['via']; x: number; y: number; dx: number; last?: { left: number; right: number; top: number; bottom: number } } | null = null
    private hoverId: string | null = null
    private openTimer: ReturnType<typeof setTimeout> | null = null
    private closeTimer: ReturnType<typeof setTimeout> | null = null

    constructor(private readonly view: EditorView) {
      this.style = document.createElement('style')
      this.style.setAttribute('data-ai-flash', '')
      view.dom.appendChild(this.style)
      view.dom.addEventListener('mousemove', this.onMove)
      view.dom.addEventListener('mouseleave', this.onLeave)
      view.dom.addEventListener('mousedown', this.onDown)
      this.unsubscribe = source.subscribe(added => {
        this.pending.push(...added)
        this.schedule()
      })
    }

    // ── Les points qui arrivent ─────────────────────────────────────────────

    /** Jamais pendant une mise a jour de CodeMirror, et apres que le texte recu y est : on attend la fin du tour. */
    private schedule(): void {
      if (this.scheduled || this.destroyed) return
      this.scheduled = true
      queueMicrotask(() => {
        this.scheduled = false
        if (!this.destroyed) this.sync()
      })
    }

    private sync(): void {
      const view = this.view
      const added = [...new Set(this.pending.splice(0))]
      const state = view.state.field(field)
      if (!added.length && !state.flashes.length) return
      const infos = source.list()
      const now = Date.now()
      const length = view.state.doc.length
      // Un point annule ailleurs (ou parti) pendant qu'on le montre : sa trace part.
      const gone = state.flashes
        .filter(f => !f.done && !infos.some(i => i.parts.includes(f.id) && !i.undone))
        .map(f => f.id)
      const fresh: Flash[] = []
      for (const id of added) {
        // Un point compacte regroupe d'anciens points : rien de neuf a montrer.
        if (id.startsWith('c|')) continue
        const info = infos.find(i => i.parts.includes(id))
        if (!info || info.undone) continue
        const at = Date.parse(info.last ?? info.at)
        if (!(at >= this.openedAt - LOAD_SLACK_MS) || now - at > AI_FLASH_FRESH_MS) continue
        const where = source.ranges(info.parts)
        const inserted = where.inserted
          .map(r => ({ from: Math.max(0, Math.min(r.from, length)), to: Math.max(0, Math.min(r.to, length)) }))
          .filter(r => r.to > r.from)
        const deleted = where.deleted.filter(d => d.text).map(d => ({ at: Math.max(0, Math.min(d.at, length)), text: d.text }))
        if (!inserted.length && !deleted.length) continue
        const before = state.flashes.find(f => f.id === id)
        fresh.push({ id, slot: before?.slot ?? nextSlot++, info, color: rgbOf(info.agent.color).hex, startedAt: now, inserted, deleted })
      }
      // Trop a la fois : les plus anciens partent (pas celui dont la carte est ouverte).
      const kept = state.flashes.filter(f => !gone.includes(f.id) && !fresh.some(n => n.id === f.id))
      const extra = kept.length + fresh.length - MAX_FLASHES
      if (extra > 0) gone.push(...kept.filter(f => f.id !== state.open?.id).slice(0, extra).map(f => f.id))
      if (!gone.length && !fresh.length) return
      view.dispatch({ effects: [dropFlashes.of(gone), putFlashes.of(fresh)] })
      this.tidy()
    }

    // ── Le fondu ────────────────────────────────────────────────────────────

    private tick(): void {
      const state = this.view.state.field(field)
      const now = Date.now()
      const over = state.flashes
        .filter(f => !f.done && now - f.startedAt >= AI_FLASH_MS && state.open?.id !== f.id)
        .map(f => f.id)
      if (over.length) {
        this.view.dispatch({ effects: dropFlashes.of(over) })
        this.tidy()
      } else {
        this.paint()
      }
    }

    /** La feuille de style du moment : chaque surlignage a sa force. */
    private paint(): void {
      const { flashes, open } = this.view.state.field(field)
      const now = Date.now()
      const reduced = reducedMotion()
      const css = flashes
        .filter(f => !f.done)
        .map(f => rules(f, aiFlashStrength(now - f.startedAt, open?.id === f.id, reduced)))
        .join('\n')
      if (css === this.css) return
      this.css = css
      this.style.textContent = css
    }

    /**
     * Met la marge, le style et l'horloge d'accord avec les surlignages du
     * moment. Jamais pendant une mise a jour de CodeMirror (il pose des marques).
     */
    private tidy(): void {
      if (this.destroyed || this.tidying) return
      this.tidying = true
      try {
        const view = this.view
        const live = view.state.field(field).flashes.filter(f => !f.done)
        for (const [id, was] of [...this.shown]) {
          if (live.some(f => f.id === id)) continue
          this.shown.delete(id)
          this.domRanges.delete(id)
          applyBlockMarks(view, markOwner(id), [])
          setDomHighlight(highlightName(was.slot), view, [])
        }
        for (const f of live) {
          const key = `${f.slot}:${f.startedAt}`
          if (this.shown.get(f.id)?.key === key) continue
          this.shown.set(f.id, { slot: f.slot, key })
          const mark = (from: number, to: number): BlockMark => ({
            from, to, className: `cm-block-ai-flash cm-block-ai-flash-${f.slot}`, title: `${whoOf(f.info)} vient de modifier ce passage`, color: f.color,
          })
          applyBlockMarks(view, markOwner(f.id), [...f.inserted.map(r => mark(r.from, r.to)), ...f.deleted.map(d => mark(d.at, d.at))])
        }
        this.paint()
        if (view.state.field(field).flashes.length) {
          this.ticker ??= setInterval(() => this.tick(), STEP_MS)
        } else if (this.ticker !== null) {
          clearInterval(this.ticker)
          this.ticker = null
        }
      } finally {
        this.tidying = false
      }
    }

    update(u: ViewUpdate): void {
      const before = u.startState.field(field)
      const now = u.state.field(field)
      if (before.flashes !== now.flashes && !this.tidying) {
        // Filet : un surlignage parti sans passer par ici (carte fermee apres une annulation).
        queueMicrotask(() => this.tidy())
      }
      if (before.open !== now.open) this.paint()
      // La personne se remet a ecrire : la carte s'efface devant le texte.
      if (now.open && u.docChanged && u.transactions.some(tr => tr.isUserEvent('input') || tr.isUserEvent('delete'))) {
        queueMicrotask(() => { if (!this.destroyed) this.closeCard() })
      }
      const live = now.flashes.some(f => !f.done)
      if ((live || this.domRanges.size) && (before.flashes !== now.flashes || u.docChanged || u.viewportChanged || u.selectionSet || u.geometryChanged)) {
        this.measure()
      }
    }

    /** Le texte rendu des ajouts : surligne par le navigateur, apres le dessin. */
    private measure(): void {
      if (!domHighlights()) return
      this.view.requestMeasure({
        key: this,
        read: view => {
          const out = new Map<string, { slot: number; ranges: Range[] }>()
          for (const f of view.state.field(field).flashes) {
            if (!f.done) out.set(f.id, { slot: f.slot, ranges: renderedRangesOf(view, f.inserted) })
          }
          return out
        },
        write: (out, view) => {
          if (this.destroyed) return
          this.domRanges = new Map()
          for (const [id, { slot, ranges }] of out) {
            // Parti entre-temps : tidy a deja retire son surlignage.
            if (!this.shown.has(id)) continue
            setDomHighlight(highlightName(slot), view, ranges)
            if (ranges.length) this.domRanges.set(id, ranges)
          }
        },
      })
    }

    // ── La carte ────────────────────────────────────────────────────────────

    /** Le surlignage sous la souris, et par quoi on l'a trouve : texte brut ou trace, marge, texte rendu. */
    private hit(e: MouseEvent): Hit | null {
      const live = this.view.state.field(field).flashes.filter(f => !f.done)
      if (!live.length) return null
      const target = e.target instanceof Element ? e.target : null
      const marked = target?.closest('[data-ai-change]') as HTMLElement | null
      if (marked && this.view.dom.contains(marked)) {
        const flash = live.find(x => x.id === marked.dataset.aiChange)
        if (flash) return { flash, via: 'mark' }
      }
      // La case de la marge, pas seulement son trait (trois pixels) : le plus recent de ses traits.
      const box = target?.closest('.cm-block-mark')
      if (box) {
        const slots = Array.from(box.querySelectorAll('.cm-block-ai-flash')).map(bar => Number(/cm-block-ai-flash-(\d+)/.exec(bar.className)?.[1]))
        for (let i = live.length - 1; i >= 0; i--) if (slots.includes(live[i]!.slot)) return { flash: live[i]!, via: 'bar' }
        return null
      }
      // Texte rendu : pas d'element a nous, seulement des plages. Le plus recent d'abord.
      for (let i = live.length - 1; i >= 0; i--) {
        for (const range of this.domRanges.get(live[i]!.id) ?? []) {
          for (const rect of Array.from(range.getClientRects())) {
            if (e.clientX >= rect.left && e.clientX <= rect.right && e.clientY >= rect.top && e.clientY <= rect.bottom) return { flash: live[i]!, via: 'rendered' }
          }
        }
      }
      return null
    }

    /** La position du texte ou accrocher la carte : sous la souris si elle est dans un ajout, sinon au plus pres. */
    private posOf(f: Flash, e: MouseEvent): number {
      const points = [...f.inserted.map(r => r.from), ...f.deleted.map(d => d.at)]
      let at: number | null = null
      try { at = this.view.posAtCoords({ x: e.clientX, y: e.clientY }, false) } catch { /* pas de mise en page */ }
      if (at === null) return points[0] ?? 0
      if (f.inserted.some(r => at! >= r.from && at! <= r.to)) return at
      return points.reduce((best, p) => (Math.abs(p - at!) < Math.abs(best - at!) ? p : best), points[0] ?? at)
    }

    /**
     * Ou dessiner la carte. Dans le texte brut, la position du texte suffit.
     * Dans un bloc rendu (ou depuis la marge), une position ne dit que « ce
     * bloc » : on prend le rectangle survole, pour que la carte soit sous la
     * souris.
     */
    private cardCoords(id: string, pos: number): { left: number; right: number; top: number; bottom: number } | null {
      const a = this.anchor
      if (!a || a.id !== id || a.via === 'mark') return this.view.coordsAtPos(pos)
      const slot = this.shown.get(id)?.slot
      const rects = a.via === 'bar'
        ? (slot === undefined ? [] : Array.from(this.view.dom.querySelectorAll(`.cm-block-ai-flash-${slot}`)).map(bar => bar.getBoundingClientRect()))
        : (this.domRanges.get(id) ?? []).flatMap(range => Array.from(range.getClientRects()))
      let best: DOMRect | null = null
      let bestGap = Infinity
      for (const r of rects) {
        const gap = Math.max(r.left - a.x, a.x - r.right, 0) + Math.max(r.top - a.y, a.y - r.bottom, 0)
        if (gap < bestGap) { best = r; bestGap = gap }
      }
      // Plus de rectangle (point annule) : la carte reste ou elle etait.
      if (!best) return a.last ?? this.view.coordsAtPos(pos)
      if (a.via === 'bar') {
        // La marge est hors du texte (CodeMirror y cacherait la carte) : au bord du texte, a la hauteur de la souris.
        if (a.dx < 0) a.dx = Math.max(0, Math.min(a.y - best.top, best.height))
        const left = Math.max(best.right, this.view.contentDOM.getBoundingClientRect().left) + 1
        a.y = best.top + Math.min(a.dx, best.height)
        a.last = { left, right: left, top: a.y - 9, bottom: a.y + 9 }
        return a.last
      }
      if (a.dx < 0) a.dx = Math.max(0, Math.min(a.x - best.left, best.width))
      const left = best.left + Math.min(a.dx, best.width)
      a.x = left
      a.y = (best.top + best.bottom) / 2
      a.last = { left, right: left, top: best.top, bottom: best.bottom }
      return a.last
    }

    private stopTimers(): void {
      if (this.openTimer !== null) clearTimeout(this.openTimer)
      if (this.closeTimer !== null) clearTimeout(this.closeTimer)
      this.openTimer = this.closeTimer = null
    }

    private openCard(hit: Hit, at: { pos: number; x: number; y: number }, pinned: boolean): void {
      this.stopTimers()
      const view = this.view
      const state = view.state.field(field)
      const id = hit.flash.id
      if (!state.flashes.some(f => f.id === id && !f.done)) return
      const current = state.open
      // La meme carte : on la garde (et ce qu'elle dit), au plus on l'epingle.
      if (current?.id === id) {
        if (pinned && !current.pinned) view.dispatch({ effects: setCard.of({ ...current, pinned: true }) })
        return
      }
      this.anchor = { id, via: hit.via, x: at.x, y: at.y, dx: -1 }
      view.dispatch({ effects: setCard.of({ id, pos: Math.min(at.pos, view.state.doc.length), pinned, create: v => this.card(v, id) }) })
    }

    private closeCard(): void {
      this.stopTimers()
      this.hoverId = null
      if (this.view.state.field(field).open) this.view.dispatch({ effects: setCard.of(null) })
    }

    private readonly onMove = (e: MouseEvent): void => {
      const state = this.view.state.field(field)
      if (!state.flashes.length) return
      const target = e.target instanceof Element ? e.target : null
      // Sur la carte : elle reste.
      if (target?.closest('.cm-ai-change-card')) {
        this.stopTimers()
        this.hoverId = null
        return
      }
      const hit = this.hit(e)
      if (!hit) {
        this.away()
        return
      }
      const id = hit.flash.id
      if (this.closeTimer !== null) { clearTimeout(this.closeTimer); this.closeTimer = null }
      if (state.open?.id === id || this.hoverId === id) return
      this.hoverId = id
      if (this.openTimer !== null) clearTimeout(this.openTimer)
      const at = { pos: this.posOf(hit.flash, e), x: e.clientX, y: e.clientY }
      this.openTimer = setTimeout(() => {
        this.openTimer = null
        this.hoverId = null
        if (!this.destroyed) this.openCard(hit, at, false)
      }, HOVER_OPEN_MS)
    }

    /** La souris n'est plus sur un surlignage : la carte ouverte au survol se ferme, apres un instant. */
    private away(): void {
      this.hoverId = null
      if (this.openTimer !== null) { clearTimeout(this.openTimer); this.openTimer = null }
      const open = this.view.state.field(field).open
      if (!open || open.pinned || this.closeTimer !== null) return
      this.closeTimer = setTimeout(() => {
        this.closeTimer = null
        if (!this.destroyed) this.closeCard()
      }, HOVER_CLOSE_MS)
    }

    private readonly onLeave = (): void => {
      if (this.view.state.field(field).flashes.length) this.away()
    }

    private readonly onDown = (e: MouseEvent): void => {
      if (e.button !== 0) return
      const state = this.view.state.field(field)
      if (!state.flashes.length) return
      const target = e.target instanceof Element ? e.target : null
      if (target?.closest('.cm-ai-change-card')) return
      const hit = this.hit(e)
      if (hit) this.openCard(hit, { pos: this.posOf(hit.flash, e), x: e.clientX, y: e.clientY }, true)
      else if (state.open) this.closeCard()
    }

    /** La carte d'un point : qui, quoi, pourquoi, annuler, voir dans l'historique. */
    private card(view: EditorView, id: string): TooltipView {
      const dom = document.createElement('div')
      dom.className = 'cm-ai-change-card'
      dom.dataset.testid = 'ai-change-card'
      dom.dataset.aiChange = id
      const flash = view.state.field(field).flashes.find(f => f.id === id)
      // CodeMirror admet « pas de position » (la carte est alors cachee), son type non.
      const getCoords = (pos: number) => this.cardCoords(id, pos) as NonNullable<ReturnType<FlashView['cardCoords']>>
      if (!flash) return { dom, getCoords }
      const { info } = flash
      const el = (tag: string, className: string, text?: string): HTMLElement => {
        const node = document.createElement(tag)
        node.className = className
        if (text !== undefined) node.textContent = text
        return node
      }
      const head = el('div', 'cm-ai-change-head')
      const dot = el('span', 'cm-ai-change-dot')
      dot.style.backgroundColor = flash.color
      const who = el('span', 'cm-ai-change-who', whoOf(info))
      who.dataset.testid = 'ai-change-who'
      head.append(dot, who)
      dom.append(head, el('div', 'cm-ai-change-summary', summaryOf(info)))
      // Ce qu'il a supprime : dans un bloc rendu, la trace ne se voit pas dans le texte.
      for (const d of flash.deleted.slice(0, MAX_CARD_DELETED)) dom.appendChild(el('div', 'cm-ai-change-deleted', traceText(d.text)))
      if (flash.deleted.length > MAX_CARD_DELETED) dom.appendChild(el('div', 'cm-ai-change-more', `… et ${flash.deleted.length - MAX_CARD_DELETED} de plus`))
      for (const reason of info.reasons) {
        if (reason.trim()) dom.appendChild(el('div', 'cm-ai-change-reason', reason.trim()))
      }
      const status = el('div', 'cm-ai-change-status')
      status.setAttribute('role', 'status')
      status.dataset.testid = 'ai-change-status'
      const actions = el('div', 'cm-ai-change-actions')
      const button = (label: string, testid: string, title: string, run: () => void): HTMLButtonElement => {
        const b = document.createElement('button')
        b.type = 'button'
        b.className = 'cm-ai-change-btn'
        b.dataset.testid = testid
        b.textContent = label
        b.title = title
        // Le curseur reste ou il est : la carte n'est pas du texte.
        b.addEventListener('mousedown', e => { e.preventDefault(); e.stopPropagation() })
        b.addEventListener('click', e => { e.stopPropagation(); run() })
        actions.appendChild(b)
        return b
      }
      const host = hostOf(view.state)
      const undo = source.undo
      if (undo && host?.me() && !view.state.readOnly) {
        const b = button('Annuler', 'ai-change-undo', 'Retirer cette modification de l’IA, et elle seule', () => {
          const me = hostOf(view.state)?.me()
          if (!me) return
          let result: { ok: boolean; partial: boolean } | null = null
          try { result = undo(info.parts, me) } catch { result = null }
          if (!result) {
            status.textContent = 'L’annulation a échoué.'
            return
          }
          status.textContent = !result.ok
            ? 'Rien à annuler : cette modification l’a déjà été.'
            : result.partial
              ? 'Annulée en partie : du texte supprimé n’a pas pu être remis à sa place.'
              : 'Modification annulée.'
          b.disabled = true
          // Plus de trace dans le texte ; la carte reste (epinglee), pour dire ce qui s'est passe.
          this.stopTimers()
          const open = view.state.field(field).open
          view.dispatch({ effects: [doneFlash.of(id), ...(open?.id === id ? [setCard.of({ ...open, pinned: true })] : [])] })
          this.tidy()
        })
      }
      const docId = options.docId
      if (host?.showHistory && docId) {
        button('Historique', 'ai-change-history', 'Voir cette modification dans le panneau Révision', () => {
          hostOf(view.state)?.showHistory?.(docId, info.id)
          this.closeCard()
        })
      }
      if (actions.childElementCount) dom.appendChild(actions)
      dom.appendChild(status)
      // Les touches tapees dans la carte ne vont pas a l'editeur.
      dom.addEventListener('keydown', e => {
        e.stopPropagation()
        if (e.key === 'Escape') { e.preventDefault(); this.closeCard(); view.focus() }
      })
      return { dom, getCoords }
    }

    destroy(): void {
      this.destroyed = true
      this.unsubscribe()
      this.stopTimers()
      if (this.ticker !== null) clearInterval(this.ticker)
      this.view.dom.removeEventListener('mousemove', this.onMove)
      this.view.dom.removeEventListener('mouseleave', this.onLeave)
      this.view.dom.removeEventListener('mousedown', this.onDown)
      for (const { slot } of this.shown.values()) setDomHighlight(highlightName(slot), this.view, [])
      this.style.remove()
    }
  }

  const escape = EditorView.domEventHandlers({
    keydown(event, view) {
      if (event.key !== 'Escape' || !view.state.field(field).open) return false
      view.dispatch({ effects: setCard.of(null) })
      return true
    },
  })

  return [field, ViewPlugin.fromClass(FlashView), escape, theme]
}

const theme = EditorView.baseTheme({
  '.cm-ai-flash': { borderRadius: '2px', transition: `background-color ${STEP_MS}ms linear, box-shadow ${STEP_MS}ms linear` },
  '.cm-ai-flash-del': {
    textDecoration: 'line-through', marginRight: '3px', userSelect: 'none', cursor: 'default',
    transition: `opacity ${STEP_MS}ms linear`,
  },
  '.cm-block-mark-bar.cm-block-ai-flash': { transition: `opacity ${STEP_MS}ms linear`, cursor: 'pointer' },
  '.cm-tooltip.cm-ai-change-card': {
    width: 'min(300px, 86vw)', padding: '8px 10px', boxSizing: 'border-box',
    display: 'flex', flexDirection: 'column', gap: '4px',
    backgroundColor: 'var(--bg-elevated, var(--bg-surface, #fff))', color: 'var(--text, #1f2937)',
    border: '1px solid var(--border, #d1d5db)', borderRadius: '8px', boxShadow: '0 6px 24px rgba(0, 0, 0, 0.25)',
    fontFamily: 'var(--font-ui, sans-serif)', fontSize: '12px', lineHeight: '1.4',
  },
  '&dark .cm-tooltip.cm-ai-change-card': {
    backgroundColor: 'var(--bg-elevated, var(--bg-surface, #1e1e2e))', color: 'var(--text, #e5e7eb)',
    border: '1px solid var(--border, #313244)',
  },
  '.cm-ai-change-head': { display: 'flex', alignItems: 'center', gap: '6px', fontWeight: '600' },
  '.cm-ai-change-dot': { width: '8px', height: '8px', borderRadius: '50%', flex: 'none' },
  '.cm-ai-change-summary': { whiteSpace: 'pre-wrap' },
  '.cm-ai-change-deleted': { textDecoration: 'line-through', color: 'var(--text-muted, #6b7280)', overflowWrap: 'anywhere' },
  '.cm-ai-change-more': { fontSize: '11px', color: 'var(--text-muted, #6b7280)' },
  '.cm-ai-change-reason': { color: 'var(--text-muted, #6b7280)', whiteSpace: 'pre-wrap', paddingLeft: '6px', borderLeft: '2px solid var(--border, #d1d5db)' },
  '.cm-ai-change-actions': { display: 'flex', gap: '6px', marginTop: '4px' },
  '.cm-ai-change-btn': {
    fontSize: '11px', padding: '2px 8px', borderRadius: '4px', cursor: 'pointer',
    border: '1px solid var(--border, #d1d5db)', backgroundColor: 'transparent', color: 'inherit',
  },
  '.cm-ai-change-btn:disabled': { opacity: '0.5', cursor: 'default' },
  '.cm-ai-change-status': { fontSize: '11px', color: 'var(--text-muted, #6b7280)' },
  '.cm-ai-change-status:empty': { display: 'none' },
})

/**
 * L'extension pour le CRDT d'une note, s'il tient les points de l'IA
 * (sinon, rien).
 */
export function aiChangeFlashFor(crdt: ICRDT | undefined, options: AiChangeFlashOptions = {}): Extension[] {
  if (!crdt?.onAiChangesChange || !crdt.aiChanges || !crdt.aiChangeRanges) return []
  return [aiChangeFlashExtension({
    list: () => crdt.aiChanges!(),
    subscribe: cb => crdt.onAiChangesChange!(cb),
    ranges: parts => crdt.aiChangeRanges!(parts),
    ...(crdt.undoAiChange ? { undo: (parts: readonly string[], by: AiChangeWho) => crdt.undoAiChange!(parts, by) } : {}),
  }, options)]
}

/** Donne (ou retire) l'hote des cartes : sans lui, la carte montre le point, sans boutons. */
export function setAiChangeHost(view: EditorView, host: AiChangeHost | null): void {
  if (view.state.field(field, false)) view.dispatch({ effects: setHost.of(host) })
}

/** Les surlignages en cours, a jour des modifications du texte (tests, outils). */
export function aiChangeFlashes(state: EditorState): { id: string; color: string; inserted: readonly { from: number; to: number }[]; deleted: readonly { at: number; text: string }[] }[] {
  return (state.field(field, false)?.flashes ?? [])
    .filter(f => !f.done)
    .map(f => ({ id: f.id, color: f.color, inserted: f.inserted, deleted: f.deleted }))
}

/** Le point dont la carte est ouverte. */
export function openedAiChange(state: EditorState): string | null {
  return state.field(field, false)?.open?.id ?? null
}
