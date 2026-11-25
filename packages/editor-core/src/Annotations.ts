// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Annotations dans la note : on travaille la revision sans quitter le texte.
//
// Les passages surlignes (Highlights : commentaires, suggestions) s'ouvrent
// d'un clic dans une carte posee par-dessus l'editeur, a cote du passage. La
// carte vient de l'hote (l'application) : elle montre le fil, et permet d'y
// repondre, d'accepter ou de refuser une suggestion, de resoudre un
// commentaire. L'hote peut aussi y ouvrir un brouillon (« Commenter » sur la
// selection).
//
// L'editeur ne sait rien de la revision : il dit seulement quels passages on
// a ouverts. Sans hote, un clic ne fait rien de plus que placer le curseur.
//
// Editeur assez large : les fils sont dans la marge (MarginComments.ts), qui
// prend alors la place de la carte flottante (annotationPlace).

import { Facet, StateEffect, StateField, type EditorState, type Extension } from '@codemirror/state'
import { EditorView, ViewPlugin, showTooltip, type Tooltip, type TooltipView } from '@codemirror/view'
import { applyHighlights, highlightIdsAt, highlightsExtension, type EditorHighlight } from './Highlights'

/** Brouillon ouvert dans la carte : commenter ou suggerer sur [from, to). */
export interface AnnotationDraft {
  kind: 'comment' | 'suggestion'
  from: number
  to: number
}

/** Ce que l'hote dessine dans la carte. Chaque fonction rend son nettoyage. */
export interface AnnotationHost {
  /** Les fils `ids` (du passage le plus precis au plus large). `close` ferme la carte. */
  render(ids: string[], dom: HTMLElement, close: () => void): () => void
  /** Un brouillon sur la selection (facultatif). */
  renderDraft?(draft: AnnotationDraft, dom: HTMLElement, close: () => void): () => void
}

type Opened =
  | { what: 'threads'; ids: string[]; pos: number; create: (view: EditorView) => TooltipView }
  | { what: 'draft'; draft: AnnotationDraft; pos: number; create: (view: EditorView) => TooltipView }

interface PopoverState {
  host: AnnotationHost | null
  open: Opened | null
}

const setHost = StateEffect.define<AnnotationHost | null>()
const setOpen = StateEffect.define<Opened | null>()

/** Hote fixe (editeurs des plugins) ; un hote pose par setAnnotationHost l'emporte. */
const staticHost = Facet.define<AnnotationHost, AnnotationHost | null>({
  combine: values => values[0] ?? null,
})

const hostOf = (state: EditorState): AnnotationHost | null =>
  state.field(popover, false)?.host ?? state.facet(staticHost)

/** L'hote des cartes de cet editeur, s'il en a un. */
export function annotationHostOf(state: EditorState): AnnotationHost | null {
  return hostOf(state)
}

/**
 * Un autre endroit que la carte flottante pour montrer les annotations (la
 * marge, MarginComments.ts). Chaque fonction rend true quand elle s'en
 * charge : la carte flottante ne s'ouvre alors pas.
 */
export interface AnnotationPlace {
  /** Un clic sur les passages `ids` (liste vide : un clic hors de tout passage). */
  threads(view: EditorView, ids: string[]): boolean
  /** Un brouillon sur la selection. */
  draft(view: EditorView, draft: AnnotationDraft): boolean
}

export const annotationPlace = Facet.define<AnnotationPlace, AnnotationPlace | null>({
  combine: values => values[0] ?? null,
})

const popover = StateField.define<PopoverState>({
  create: () => ({ host: null, open: null }),
  update(value, tr) {
    let next = value
    for (const e of tr.effects) {
      if (e.is(setHost)) next = { host: e.value, open: e.value ? next.open : null }
      if (e.is(setOpen)) next = { ...next, open: e.value }
    }
    // La carte suit son passage quand le texte change (meme `create` : CodeMirror
    // garde la carte, et ce qu'on y tapait).
    if (tr.docChanged && next.open) {
      const open = next.open
      const pos = tr.changes.mapPos(open.pos)
      const moved = open.what === 'draft'
        ? { ...open, pos, draft: { ...open.draft, from: tr.changes.mapPos(open.draft.from, 1), to: tr.changes.mapPos(open.draft.to, -1) } }
        : { ...open, pos }
      next = { ...next, open: moved }
    }
    return next
  },
  provide: f => showTooltip.compute([f], (state): Tooltip | null => {
    const open = state.field(f).open
    return open ? { pos: open.pos, above: false, create: open.create } : null
  }),
})

function card(view: EditorView, draw: (dom: HTMLElement, close: () => void) => () => void): TooltipView {
  const dom = document.createElement('div')
  dom.className = 'cm-annotation-card'
  dom.dataset.testid = 'annotation-card'
  // Les touches tapees dans la carte (reponse...) ne vont pas a l'editeur.
  dom.addEventListener('keydown', e => {
    e.stopPropagation()
    if (e.key === 'Escape') { e.preventDefault(); close(); view.focus() }
  })
  const close = () => { if (view.state.field(popover, false)?.open) view.dispatch({ effects: setOpen.of(null) }) }
  let cleanup: (() => void) | null = null
  return {
    dom,
    mount() { cleanup = draw(dom, close) },
    destroy() { cleanup?.() },
  }
}

function openThreads(ids: string[], pos: number): Opened {
  const opened: Opened = {
    what: 'threads', ids, pos,
    create: view => card(view, (dom, close) => hostOf(view.state)?.render(ids, dom, close) ?? (() => {})),
  }
  return opened
}

const clicks = EditorView.domEventHandlers({
  mousedown(event, view) {
    if (event.button !== 0 || !hostOf(view.state)) return false
    const target = event.target as HTMLElement | null
    const pos = view.posAtCoords({ x: event.clientX, y: event.clientY })
    const onMark = target?.closest?.('[data-highlight-id]') as HTMLElement | null
    const ids = pos === null ? [] : highlightIdsAt(view.state, pos)
    const first = onMark?.dataset.highlightId
    if (first && !ids.includes(first)) ids.unshift(first)
    // La marge, quand elle est visible, montre le fil a la place de la carte.
    const taken = view.state.facet(annotationPlace)?.threads(view, ids) ?? false
    const current = view.state.field(popover).open
    if (ids.length === 0 || taken) {
      if (current?.what === 'threads') view.dispatch({ effects: setOpen.of(null) })
      return false
    }
    if (current?.what === 'threads' && current.ids.join() === ids.join()) return false
    view.dispatch({ effects: setOpen.of(openThreads(ids, pos ?? 0)) })
    return false
  },
  keydown(event, view) {
    if (event.key !== 'Escape' || !view.state.field(popover).open) return false
    view.dispatch({ effects: setOpen.of(null) })
    return true
  },
})

/** Les cartes d'annotation. `host` : hote fixe (sinon, setAnnotationHost). */
export function annotationsExtension(host?: AnnotationHost): Extension {
  return [popover, clicks, ...(host ? [staticHost.of(host)] : [])]
}

/** Donne (ou retire) l'hote des cartes : sans hote, aucune carte ne s'ouvre. */
export function setAnnotationHost(view: EditorView, host: AnnotationHost | null): void {
  view.dispatch({ effects: setHost.of(host) })
}

/** Ouvre la carte des fils `ids`, a la position `pos`. */
export function openAnnotations(view: EditorView, ids: string[], pos: number): void {
  if (!hostOf(view.state) || ids.length === 0) return
  if (view.state.facet(annotationPlace)?.threads(view, ids)) return
  view.dispatch({ effects: setOpen.of(openThreads(ids, pos)) })
}

/** Ouvre un brouillon sur [from, to) ; false si l'hote ne sait pas en dessiner. */
export function openAnnotationDraft(view: EditorView, draft: AnnotationDraft): boolean {
  const host = hostOf(view.state)
  if (!host?.renderDraft) return false
  if (view.state.facet(annotationPlace)?.draft(view, draft)) { closeAnnotations(view); return true }
  const opened: Opened = {
    what: 'draft', draft, pos: draft.to,
    create: v => card(v, (dom, close) => {
      // Le passage vise, a jour des modifications faites pendant qu'on ecrit.
      const now = v.state.field(popover).open
      const current = now?.what === 'draft' ? now.draft : draft
      return hostOf(v.state)?.renderDraft?.(current, dom, close) ?? (() => {})
    }),
  }
  view.dispatch({ effects: setOpen.of(opened) })
  return true
}

/** Ferme la carte ouverte. */
export function closeAnnotations(view: EditorView): void {
  if (view.state.field(popover, false)?.open) view.dispatch({ effects: setOpen.of(null) })
}

/** La carte ouverte (tests, affichage). */
export function openedAnnotation(state: EditorState): { ids: string[] } | { draft: AnnotationDraft } | null {
  const open = state.field(popover, false)?.open
  if (!open) return null
  return open.what === 'threads' ? { ids: open.ids } : { draft: open.draft }
}

/** D'ou viennent les passages a surligner (editeurs de texte des plugins). */
export interface AnnotationSource {
  /** Les passages, calcules sur le texte du moment. */
  ranges(text: string): EditorHighlight[]
  /** Previent quand les passages changent. Rend le desabonnement. */
  subscribe(onChange: () => void): () => void
}

/**
 * Tout pour un editeur CodeMirror autre que la note (texte d'un plugin) :
 * passages surlignes tenus a jour par `source`, cartes dessinees par `host`.
 */
export function reviewOverlayExtension(host: AnnotationHost, source: AnnotationSource): Extension {
  const sync = ViewPlugin.define(view => {
    let alive = true
    const refresh = () => {
      // Jamais pendant une mise a jour de l'editeur.
      queueMicrotask(() => { if (alive) applyHighlights(view, source.ranges(view.state.doc.toString())) })
    }
    const stop = source.subscribe(refresh)
    refresh()
    return { destroy() { alive = false; stop() } }
  })
  return [highlightsExtension(), annotationsExtension(host), sync]
}
