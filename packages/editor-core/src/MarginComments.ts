// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Commentaires dans la marge : a droite du texte, une petite carte par fil
// ouvert, a la hauteur du passage qu'il vise (comme dans un traitement de
// texte en ligne). Le panneau Revision reste la liste complete.
//
//  - L'hote donne les fils (auteur, debut du texte, reponses). Chacun porte
//    l'identifiant de son passage surligne (Highlights) : c'est le passage
//    qui dit ou va la carte, et il suit les modifications du texte. Un fil
//    sans passage (commentaire sur toute la note) n'est pas dans la marge.
//  - Plusieurs fils au meme endroit : les cartes s'empilent vers le bas. La
//    carte choisie (clic sur elle, ou sur son passage) se met exactement a la
//    hauteur de son passage ; celles du dessus remontent pour lui faire place.
//  - La carte choisie s'ouvre sur le fil entier, dessine par l'hote des
//    annotations (AnnotationHost) : un seul code dessine un fil.
//  - Editeur etroit (telephone, panneau reduit) : pas de marge. Un clic sur
//    un passage ouvre alors sa carte flottante (Annotations.ts).
//
// La colonne vit dans la zone de defilement de l'editeur : elle defile avec
// le texte, sans rien recalculer. Les hauteurs se mesurent dans
// requestMeasure, jamais pendant une mise a jour.

import { StateEffect, StateField, type EditorState, type Extension } from '@codemirror/state'
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from '@codemirror/view'
import {
  annotationHostOf, annotationPlace, closeAnnotations, openedAnnotation,
  type AnnotationDraft, type AnnotationHost, type AnnotationPlace,
} from './Annotations'
import { highlightRangesById, isHighlightsEffect } from './Highlights'

/** Un fil montre dans la marge. */
export interface MarginComment {
  /** Identifiant du fil : celui de son passage surligne (EditorHighlight.id). */
  id: string
  author: string
  /** Le texte du fil (la carte en montre le debut). */
  text: string
  /** Nombre de reponses. */
  replies: number
  /** Etiquette courte (« Suggestion »). */
  label?: string
  /** Ecrit par un agent : pastille « IA ». */
  agent?: boolean
}

export interface MarginCommentsOptions {
  /** En dessous de cette largeur d'editeur, pas de marge. */
  minWidth?: number
  /** Largeur de l'editeur (tests : le DOM simule n'a pas de mise en page). */
  width?: (view: EditorView) => number
}

/** Largeur d'une carte, et de la colonne (la carte et un peu d'air de chaque cote). */
export const MARGIN_CARD_WIDTH = 232
export const MARGIN_COLUMN_WIDTH = MARGIN_CARD_WIDTH + 16
/** Espace entre deux cartes. */
export const MARGIN_GAP = 8
/** Largeur d'editeur a partir de laquelle la marge s'affiche. */
export const MARGIN_MIN_EDITOR_WIDTH = 800

// ── Mise en page (fonctions pures) ─────────────────────────────────────────

/** Une carte a placer : la hauteur voulue (celle de son passage) et sa taille. */
export interface MarginBox {
  id: string
  top: number
  height: number
}

/**
 * Place les cartes, sans chevauchement. Rend le haut de chacune.
 *  - Triees par hauteur voulue (a egalite : l'ordre donne, celui du texte).
 *  - Chacune a sa hauteur voulue, ou sous la precedente (`gap` entre deux).
 *  - `anchor` : cette carte est exactement a sa hauteur ; celles du dessus
 *    remontent juste ce qu'il faut. S'il n'y a pas la place au-dessus (`min` :
 *    le haut de la note), elles se serrent tout en haut et la carte choisie
 *    vient juste dessous : au plus pres de son passage.
 */
export function layoutMargin(boxes: readonly MarginBox[], anchor: string | null = null, gap = MARGIN_GAP, min = 0): Map<string, number> {
  const sorted = boxes.map((box, order) => ({ ...box, order })).sort((a, b) => a.top - b.top || a.order - b.order)
  const tops: number[] = []
  const stackFrom = (start: number, floor: number): void => {
    for (let i = start; i < sorted.length; i++) {
      tops[i] = Math.max(sorted[i].top, floor)
      floor = tops[i] + sorted[i].height + gap
    }
  }
  stackFrom(0, min)
  const at = anchor === null ? -1 : sorted.findIndex(b => b.id === anchor)
  const wanted = at < 0 ? 0 : Math.max(sorted[at].top, min)
  if (at >= 0 && tops[at] > wanted) {
    const up = tops.slice(0, at + 1)
    up[at] = wanted
    for (let i = at - 1; i >= 0; i--) {
      const ceiling = up[i + 1] - gap - sorted[i].height
      if (up[i] <= ceiling) break
      up[i] = ceiling
    }
    // Pas la place : tout redescend d'autant, aucune carte ne passe au-dessus de `min`.
    const lack = Math.max(0, min - up[0])
    for (let i = 0; i <= at; i++) tops[i] = up[i] + lack
    stackFrom(at + 1, tops[at] + sorted[at].height + gap)
  }
  return new Map(sorted.map((b, i) => [b.id, tops[i]]))
}

/**
 * La place de la colonne. Le texte est centre dans l'editeur, avec une
 * largeur maximale : s'il reste assez de place a sa droite, rien ne bouge ;
 * sinon l'editeur reserve `pad` a droite (le texte se decale d'autant, ou se
 * resserre). `right` : distance entre la colonne et le bord droit, pour
 * qu'elle touche le texte.
 */
export function marginGeometry(editorWidth: number, guttersWidth: number, contentMaxWidth: number, column = MARGIN_COLUMN_WIDTH): { pad: number; right: number } {
  // Place libre autour du texte quand il a toute sa largeur.
  const free = editorWidth - guttersWidth - contentMaxWidth
  return {
    pad: Math.max(0, Math.min(column, 2 * column - free)),
    right: Math.max(0, free / 2 - column),
  }
}

// ── Etat ───────────────────────────────────────────────────────────────────

interface MarginState {
  items: readonly MarginComment[]
  /** Le fil choisi (carte ouverte, a la hauteur de son passage). */
  selected: string | null
  /** Brouillon en cours dans la marge, et sa cle de carte. */
  draft: AnnotationDraft | null
  draftKey: string
  /** L'editeur est assez large pour la marge (mesure). */
  wide: boolean
}

const setItems = StateEffect.define<readonly MarginComment[]>()
const setSelected = StateEffect.define<string | null>()
const setDraft = StateEffect.define<AnnotationDraft | null>()
const setWide = StateEffect.define<boolean>()

let draftCount = 0

const field = StateField.define<MarginState>({
  create: () => ({ items: [], selected: null, draft: null, draftKey: '', wide: false }),
  update(value, tr) {
    let next = value
    for (const e of tr.effects) {
      if (e.is(setItems)) next = { ...next, items: e.value, selected: e.value.some(i => i.id === next.selected) ? next.selected : null }
      // Un brouillon ouvert reste ouvert : on n'y perd pas ce qu'on tapait.
      if (e.is(setSelected)) next = { ...next, selected: e.value }
      if (e.is(setDraft)) next = { ...next, draft: e.value, draftKey: e.value ? `\u0000draft-${++draftCount}` : '', selected: e.value ? null : next.selected }
      if (e.is(setWide)) next = { ...next, wide: e.value }
    }
    // Le brouillon suit son passage quand le texte change.
    if (tr.docChanged && next.draft) {
      const from = tr.changes.mapPos(next.draft.from, 1)
      next = { ...next, draft: { ...next.draft, from, to: Math.max(from, tr.changes.mapPos(next.draft.to, -1)) } }
    }
    return next
  },
})

/** La marge est affichee : assez de place, et un hote pour dessiner les fils. */
function marginActive(state: EditorState): boolean {
  return !!state.field(field, false)?.wide && !!annotationHostOf(state)
}

/** Le fil de `ids` (du plus precis au plus large) qui a une carte dans la marge. */
function cardAmong(state: EditorState, ids: readonly string[]): string | null {
  const { items } = state.field(field)
  const ranges = highlightRangesById(state)
  return ids.find(id => ranges.has(id) && items.some(i => i.id === id)) ?? null
}

const activeMark = Decoration.mark({ class: 'cm-margin-active' })
const draftMark = Decoration.mark({ class: 'cm-margin-draft' })

/** Le passage du fil choisi, et celui du brouillon, ressortent dans le texte. */
const marks = EditorView.decorations.of((view): DecorationSet => {
  const state = view.state
  const { selected, draft } = state.field(field)
  if ((!selected && !draft) || !marginActive(state)) return Decoration.none
  const out = []
  const at = selected ? highlightRangesById(state).get(selected) : undefined
  if (at && at.to > at.from) out.push(activeMark.range(at.from, at.to))
  if (draft && draft.to > draft.from && draft.to <= state.doc.length) out.push(draftMark.range(draft.from, draft.to))
  return Decoration.set(out, true)
})

const place: AnnotationPlace = {
  threads(view, ids) {
    if (!marginActive(view.state)) return false
    const { selected } = view.state.field(field)
    const id = cardAmong(view.state, ids)
    if (id === null) {
      // Un clic hors de tout passage referme la carte choisie.
      if (ids.length === 0 && selected) view.dispatch({ effects: setSelected.of(null) })
      return false
    }
    if (id !== selected) view.dispatch({ effects: setSelected.of(id) })
    return true
  },
  draft(view, draft) {
    if (!marginActive(view.state)) return false
    view.dispatch({ effects: setDraft.of(draft) })
    return true
  },
}

/** Echap dans le texte referme la carte choisie (pas un brouillon : on y perdrait ce qu'on tapait). */
const keys = EditorView.domEventHandlers({
  keydown(event, view) {
    if (event.key !== 'Escape' || !marginActive(view.state) || !view.state.field(field).selected) return false
    view.dispatch({ effects: setSelected.of(null) })
    return true
  },
})

// ── Les cartes ─────────────────────────────────────────────────────────────

interface Card {
  key: string
  dom: HTMLElement
  summary: HTMLElement
  body: HTMLElement
  /** Ce que montre le resume (pour ne le redessiner que s'il change). */
  shown: string
  /** Position du passage dans le texte. */
  pos: number
  /** Nettoyage du fil dessine par l'hote (carte ouverte). */
  cleanup: (() => void) | null
  host: AnnotationHost | null
  placed: boolean
}

function span(className: string, text: string): HTMLElement {
  const el = document.createElement('span')
  el.className = className
  el.textContent = text
  return el
}

function drawSummary(dom: HTMLElement, item: MarginComment): void {
  const head = document.createElement('div')
  head.className = 'cm-margin-head'
  if (item.agent) head.append(span('cm-margin-agent', 'IA'))
  head.append(span('cm-margin-author', item.author))
  if (item.label) head.append(span('cm-margin-label', item.label))
  if (item.replies > 0) head.append(span('cm-margin-replies', `${item.replies} réponse${item.replies > 1 ? 's' : ''}`))
  dom.replaceChildren(head)
  if (item.text) dom.append(Object.assign(document.createElement('div'), { className: 'cm-margin-text', textContent: item.text.slice(0, 200) }))
}

interface Measured {
  wide: boolean
  show: boolean
  pad: number
  right: number
  /** Le plus haut qu'une carte peut monter (un peu au-dessus de la premiere ligne). */
  min: number
  /** Null : la colonne n'etait pas affichee, rien a mesurer encore. */
  boxes: MarginBox[] | null
}

class MarginView {
  readonly column: HTMLElement
  private readonly cards = new Map<string, Card>()
  private readonly resize: ResizeObserver | null
  private readonly minWidth: number
  private readonly width: (view: EditorView) => number
  /** Une mise a jour de l'editeur est en cours : pas de dispatch. */
  private busy = false
  private shown = false
  private pad = -1
  private right = -1
  private destroyed = false

  constructor(readonly view: EditorView, options: MarginCommentsOptions) {
    this.minWidth = options.minWidth ?? MARGIN_MIN_EDITOR_WIDTH
    this.width = options.width ?? (v => v.scrollDOM.clientWidth)
    this.column = document.createElement('div')
    this.column.className = 'cm-margin-comments'
    this.column.dataset.testid = 'margin-comments'
    // Les touches tapees dans une carte (reponse...) ne vont pas a l'application.
    this.column.addEventListener('keydown', e => {
      e.stopPropagation()
      if (e.key !== 'Escape') return
      e.preventDefault()
      const { selected, draftKey } = view.state.field(field)
      const open = (e.target as HTMLElement | null)?.closest<HTMLElement>('.cm-margin-card')?.dataset.marginId
      this.close(open ?? selected ?? draftKey)
      view.focus()
    })
    view.scrollDOM.appendChild(this.column)
    this.resize = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => this.schedule())
    this.resize?.observe(view.scrollDOM)
    this.sync()
    this.schedule()
  }

  update(u: ViewUpdate): void {
    const changed = u.startState.field(field) !== u.state.field(field)
      || annotationHostOf(u.startState) !== annotationHostOf(u.state)
      || u.transactions.some(tr => tr.effects.some(isHighlightsEffect))
    if (changed || u.docChanged) this.sync()
    if (changed || u.docChanged || u.geometryChanged || u.viewportChanged) this.schedule()
  }

  destroy(): void {
    this.destroyed = true
    this.resize?.disconnect()
    for (const card of this.cards.values()) card.cleanup?.()
    this.cards.clear()
    this.column.remove()
  }

  /** Les cartes suivent l'etat : une par fil qui a un passage, plus le brouillon. */
  private sync(): void {
    this.busy = true
    try {
      const state = this.view.state
      const { items, selected, draft, draftKey } = state.field(field)
      const host = annotationHostOf(state)
      const wanted: { key: string; pos: number; item?: MarginComment }[] = []
      if (host) {
        const ranges = highlightRangesById(state)
        for (const item of items) {
          const at = ranges.get(item.id)
          if (at) wanted.push({ key: item.id, pos: at.from, item })
        }
        if (draft && host.renderDraft) wanted.push({ key: draftKey, pos: draft.from })
        wanted.sort((a, b) => a.pos - b.pos)
      }
      const keep = new Set(wanted.map(w => w.key))
      for (const [key, card] of this.cards) {
        if (keep.has(key)) continue
        card.cleanup?.()
        this.resize?.unobserve(card.dom)
        card.dom.remove()
        this.cards.delete(key)
      }
      let previous: HTMLElement | null = null
      for (const w of wanted) {
        const card = this.cards.get(w.key) ?? this.create(w.key)
        card.pos = w.pos
        if (w.item) {
          const shown = JSON.stringify(w.item)
          if (shown !== card.shown) { card.shown = shown; drawSummary(card.summary, w.item) }
        }
        const open = !w.item || w.key === selected
        if (!open || card.host !== host) this.collapse(card)
        if (open && !card.cleanup && host) {
          card.host = host
          card.dom.classList.add('is-selected')
          card.summary.hidden = true
          card.body.hidden = false
          const close = () => this.close(w.key)
          card.cleanup = w.item
            ? host.render([w.key], card.body, close)
            : host.renderDraft!(draft!, card.body, close)
        }
        // Dans l'ordre du texte (tabulation, lecteurs d'ecran).
        const after: Element | null = previous ? previous.nextElementSibling : this.column.firstElementChild
        if (after !== card.dom) this.column.insertBefore(card.dom, after)
        previous = card.dom
      }
    } finally {
      this.busy = false
    }
  }

  private create(key: string): Card {
    const dom = document.createElement('div')
    dom.className = 'cm-margin-card'
    dom.dataset.testid = 'margin-card'
    dom.dataset.marginId = key
    dom.style.visibility = 'hidden'
    const summary = document.createElement('div')
    summary.className = 'cm-margin-summary'
    summary.tabIndex = 0
    summary.setAttribute('role', 'button')
    summary.title = 'Ouvrir le fil'
    // Le clic garde le curseur de l'editeur ou il est.
    summary.addEventListener('mousedown', e => e.preventDefault())
    summary.addEventListener('click', () => this.select(key))
    summary.addEventListener('keydown', e => {
      if (e.key !== 'Enter' && e.key !== ' ') return
      e.preventDefault()
      this.select(key)
    })
    const body = document.createElement('div')
    body.className = 'cm-margin-body'
    body.hidden = true
    dom.append(summary, body)
    const card: Card = { key, dom, summary, body, shown: '', pos: 0, cleanup: null, host: null, placed: false }
    this.cards.set(key, card)
    this.resize?.observe(dom)
    return card
  }

  private collapse(card: Card): void {
    if (!card.cleanup) return
    card.cleanup()
    card.cleanup = null
    card.host = null
    card.body.replaceChildren()
    card.body.className = 'cm-margin-body'
    card.body.hidden = true
    card.summary.hidden = false
    card.dom.classList.remove('is-selected')
  }

  private select(key: string): void {
    if (this.view.state.field(field).selected !== key) this.view.dispatch({ effects: setSelected.of(key) })
  }

  /** Referme une carte (le fil choisi, ou le brouillon). */
  private close(key: string | null): void {
    const run = () => {
      if (this.destroyed || !key) return
      const { selected, draftKey } = this.view.state.field(field)
      if (key === draftKey) this.view.dispatch({ effects: setDraft.of(null) })
      else if (key === selected) this.view.dispatch({ effects: setSelected.of(null) })
    }
    // L'hote peut refermer pendant qu'on dessine : attendre la fin de la mise a jour.
    if (this.busy) queueMicrotask(run)
    else run()
  }

  /** La hauteur du passage a l'ecran : mesuree s'il est dessine, estimee sinon. */
  private topOf(pos: number): number {
    const view = this.view
    const at = Math.min(pos, view.state.doc.length)
    if (at >= view.viewport.from && at <= view.viewport.to) {
      try {
        const coords = view.coordsAtPos(at, 1)
        if (coords) return coords.top
      } catch { /* position non dessinee : on estime */ }
    }
    return view.documentTop + view.lineBlockAt(at).top
  }

  private schedule(): void {
    if (this.destroyed) return
    this.view.requestMeasure<Measured>({
      key: this,
      read: view => {
        const width = this.width(view)
        const wide = width >= this.minWidth
        const show = wide && this.cards.size > 0
        if (!show) return { wide, show, pad: 0, right: 0, min: 0, boxes: null }
        let gutters = 0
        for (const child of Array.from(view.scrollDOM.children)) {
          if (child.classList.contains('cm-gutters')) gutters += (child as HTMLElement).offsetWidth
        }
        const max = parseFloat(getComputedStyle(view.contentDOM).maxWidth)
        const { pad, right } = marginGeometry(width, gutters, Number.isFinite(max) ? max : Infinity)
        if (!this.shown) return { wide, show, pad, right, min: 0, boxes: null }
        const origin = this.column.getBoundingClientRect().top
        // La marge du haut de l'editeur sert aussi, a 4 px du bord.
        const min = -Math.max(0, this.column.offsetTop - 4)
        const boxes = [...this.cards.values()].map(card => ({ id: card.key, top: this.topOf(card.pos) - origin, height: card.dom.offsetHeight }))
        return { wide, show, pad, right, min, boxes }
      },
      write: (m, view) => {
        if (this.destroyed) return
        if (m.wide !== view.state.field(field).wide) this.announce(m.wide)
        let again = false
        if (m.show !== this.shown) {
          this.shown = m.show
          this.column.classList.toggle('is-shown', m.show)
          again = m.show
        }
        if (m.pad !== this.pad) {
          this.pad = m.pad
          this.column.style.width = `${m.pad}px`
          // Le texte se decale : les passages ne sont plus a la meme hauteur.
          again = again || m.show
        }
        if (m.right !== this.right) {
          this.right = m.right
          this.column.style.setProperty('--cm-margin-right', `${m.right + (MARGIN_COLUMN_WIDTH - MARGIN_CARD_WIDTH) / 2}px`)
        }
        if (m.boxes) {
          const { selected, draftKey } = view.state.field(field)
          const tops = layoutMargin(m.boxes, selected ?? (draftKey || null), MARGIN_GAP, m.min)
          for (const [key, top] of tops) {
            const card = this.cards.get(key)
            if (!card) continue
            card.dom.style.top = `${Math.round(top)}px`
            if (!card.placed) { card.placed = true; card.dom.style.visibility = '' }
          }
        }
        if (again) this.schedule()
      },
    })
  }

  /** La largeur a change de cote du seuil : l'etat le retient (hors de la mesure). */
  private announce(wide: boolean): void {
    queueMicrotask(() => {
      if (this.destroyed) return
      const view = this.view
      if (view.state.field(field).wide === wide) return
      // La carte flottante ouverte sur un fil passe dans la marge.
      const opened = wide && annotationHostOf(view.state) ? openedAnnotation(view.state) : null
      const adopt = opened && 'ids' in opened ? cardAmong(view.state, opened.ids) : null
      if (adopt) closeAnnotations(view)
      view.dispatch({ effects: [setWide.of(wide), ...(adopt ? [setSelected.of(adopt)] : [])] })
    })
  }
}

const theme = EditorView.baseTheme({
  // Une case de la zone de defilement, a droite du texte : sa largeur est la
  // place reservee. Les cartes y sont posees, calees a droite.
  '.cm-margin-comments': {
    display: 'none', position: 'relative', flex: '0 0 auto', alignSelf: 'flex-start', width: '0', height: '0',
    fontFamily: 'var(--font-ui, sans-serif)', fontSize: '12px', lineHeight: '1.4',
  },
  '.cm-margin-comments.is-shown': { display: 'block' },
  '.cm-margin-card': {
    position: 'absolute', top: '0', right: 'var(--cm-margin-right, 8px)', width: `${MARGIN_CARD_WIDTH}px`, boxSizing: 'border-box',
    zIndex: '1', borderRadius: '8px', border: '1px solid var(--border, rgba(128, 128, 128, 0.35))',
    background: 'var(--bg-surface, #fff)', color: 'var(--text, inherit)',
    transition: 'top 120ms ease, box-shadow 120ms ease',
  },
  '.cm-margin-card.is-selected': {
    zIndex: '2', padding: '8px', borderColor: 'rgba(234, 179, 8, 0.8)', boxShadow: '0 6px 24px rgba(0, 0, 0, 0.25)',
  },
  '.cm-margin-summary': { padding: '6px 8px', borderRadius: '8px', cursor: 'pointer', outline: 'none' },
  '.cm-margin-summary:hover, .cm-margin-summary:focus-visible': { background: 'rgba(234, 179, 8, 0.10)' },
  '.cm-margin-head': { display: 'flex', alignItems: 'center', gap: '6px', fontSize: '11px', color: 'var(--text-muted, inherit)' },
  '.cm-margin-author': { fontWeight: '600', color: 'var(--text, inherit)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  '.cm-margin-agent': { fontWeight: '700', padding: '0 5px', borderRadius: '4px', background: 'rgba(124, 58, 237, 0.15)', color: '#7c3aed' },
  '.cm-margin-label': { color: 'var(--text-faint, inherit)', whiteSpace: 'nowrap' },
  '.cm-margin-replies': { marginLeft: 'auto', whiteSpace: 'nowrap' },
  '.cm-margin-text': {
    display: '-webkit-box', WebkitBoxOrient: 'vertical', WebkitLineClamp: '2', overflow: 'hidden',
    whiteSpace: 'pre-wrap', overflowWrap: 'anywhere',
  },
  // Le fil dessine par l'hote : la carte de la marge lui sert deja de cadre.
  '.cm-margin-body': {
    width: 'auto', maxHeight: '60vh', overflowY: 'auto', padding: '0', border: 'none', borderRadius: '0',
    boxShadow: 'none', background: 'none',
  },
  '.cm-margin-active': { backgroundColor: 'rgba(234, 179, 8, 0.45)' },
  '.cm-margin-draft': { backgroundColor: 'rgba(234, 179, 8, 0.30)', borderRadius: '2px' },
})

/** Les commentaires dans la marge (avec annotationsExtension et highlightsExtension). */
export function marginCommentsExtension(options: MarginCommentsOptions = {}): Extension {
  return [
    field,
    marks,
    annotationPlace.of(place),
    keys,
    ViewPlugin.define(view => new MarginView(view, options)),
    theme,
  ]
}

/** Remplace les fils de la marge (liste vide : plus de cartes). */
export function applyMarginComments(view: EditorView, items: readonly MarginComment[]): void {
  if (view.state.field(field, false)) view.dispatch({ effects: setItems.of(items) })
}

/**
 * Choisit le fil `id` dans la marge (null : aucun). False si la marge n'est
 * pas affichee, ou si ce fil n'y a pas de carte.
 */
export function selectMarginComment(view: EditorView, id: string | null): boolean {
  if (!view.state.field(field, false) || !marginActive(view.state)) return false
  if (id !== null && cardAmong(view.state, [id]) === null) return false
  if (view.state.field(field).selected !== id) view.dispatch({ effects: setSelected.of(id) })
  return true
}

/** Ce que montre la marge (tests, affichage). */
export function marginCommentsState(state: EditorState): { visible: boolean; selected: string | null; draft: AnnotationDraft | null } | null {
  const value = state.field(field, false)
  if (!value) return null
  return { visible: marginActive(state), selected: value.selected, draft: value.draft }
}
