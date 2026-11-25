// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Passages surlignes par l'application (commentaires ancres, suggestions de
// la revision). L'hote donne des plages ; l'editeur les dessine et les fait
// suivre les modifications du texte jusqu'a la prochaine mise a jour.
// Le rendu en direct laisse en texte brut les lignes d'un passage surligne :
// sans cela, la ligne rendue (un widget) masquerait le surlignage.

import { StateEffect, StateField, type EditorState, type Extension } from '@codemirror/state'
import { Decoration, EditorView, WidgetType, type DecorationSet } from '@codemirror/view'

export interface EditorHighlight {
  from: number
  to: number
  /** Classe CSS du passage (couleur). */
  className: string
  /** Infobulle. */
  title?: string
  /** Identifiant rendu en data-highlight-id (clic, tests). */
  id?: string
  /**
   * Suggestion : le texte propose, affiche (en vert) juste apres le passage.
   * Avec lui, une plage vide est permise (proposition d'ajout).
   */
  insert?: string
}

class ProposedInsert extends WidgetType {
  constructor(private readonly text: string, private readonly id?: string, private readonly title?: string) { super() }
  eq(other: ProposedInsert): boolean { return other.text === this.text && other.id === this.id }
  toDOM(): HTMLElement {
    const span = document.createElement('span')
    span.className = 'review-insert'
    if (this.id) span.classList.add('review-clickable')
    span.textContent = this.text
    if (this.id) span.dataset.highlightId = this.id
    if (this.title) span.title = this.title
    return span
  }
  ignoreEvent(): boolean { return false }
}

const setHighlights = StateEffect.define<readonly EditorHighlight[]>()

function build(ranges: readonly EditorHighlight[], length: number): DecorationSet {
  const clamped = ranges
    .map(r => ({ ...r, from: Math.max(0, Math.min(r.from, length)), to: Math.max(0, Math.min(r.to, length)) }))
  const marks = clamped
    .filter(r => r.to > r.from)
    .map(r => Decoration.mark({
      class: r.id ? `${r.className} review-clickable` : r.className,
      highlightId: r.id,
      attributes: { ...(r.title ? { title: r.title } : {}), ...(r.id ? { 'data-highlight-id': r.id } : {}) },
    }).range(r.from, r.to))
  const inserts = clamped
    .filter(r => r.insert)
    .map(r => Decoration.widget({ widget: new ProposedInsert(r.insert!, r.id, r.title), side: 1, highlightId: r.id }).range(r.to))
  return Decoration.set([...marks, ...inserts], true)
}

const field = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    for (const e of tr.effects) if (e.is(setHighlights)) return build(e.value, tr.state.doc.length)
    return tr.docChanged ? deco.map(tr.changes) : deco
  },
  provide: f => EditorView.decorations.from(f),
})

/** Un changement des passages surlignes (le rendu en direct se recalcule). */
export function isHighlightsEffect(e: StateEffect<unknown>): boolean {
  return e.is(setHighlights)
}

/** Plages surlignees, a jour des modifications du texte. */
export function highlightedRanges(state: EditorState): { from: number; to: number }[] {
  const deco = state.field(field, false)
  if (!deco) return []
  const out: { from: number; to: number }[] = []
  deco.between(0, state.doc.length, (from, to) => { out.push({ from, to }) })
  return out
}

/**
 * Identifiants des passages surlignes a la position `pos` (bornes comprises :
 * un texte propose s'affiche juste apres son passage). Du plus court au plus
 * long : le passage le plus precis d'abord.
 */
export function highlightIdsAt(state: EditorState, pos: number): string[] {
  const deco = state.field(field, false)
  if (!deco) return []
  const found: { id: string; size: number }[] = []
  deco.between(pos, pos, (from, to, value) => {
    const id = (value.spec as { highlightId?: string }).highlightId
    if (id && !found.some(f => f.id === id)) found.push({ id, size: to - from })
  })
  return found.sort((a, b) => a.size - b.size).map(f => f.id)
}

/**
 * Ou se trouve chaque passage surligne qui porte un identifiant, a jour des
 * modifications du texte (commentaires dans la marge).
 */
export function highlightRangesById(state: EditorState): Map<string, { from: number; to: number }> {
  const out = new Map<string, { from: number; to: number }>()
  const deco = state.field(field, false)
  if (!deco) return out
  deco.between(0, state.doc.length, (from, to, value) => {
    const id = (value.spec as { highlightId?: string }).highlightId
    if (!id) return
    const known = out.get(id)
    out.set(id, known ? { from: Math.min(known.from, from), to: Math.max(known.to, to) } : { from, to })
  })
  return out
}

export function highlightsExtension(): Extension {
  return field
}

/** Remplace les passages surlignes. */
export function applyHighlights(view: EditorView, ranges: readonly EditorHighlight[]): void {
  view.dispatch({ effects: setHighlights.of(ranges) })
}
