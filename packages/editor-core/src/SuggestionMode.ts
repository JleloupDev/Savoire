// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Mode suggestion, comme le suivi des modifications de Word : en mode
// suggestion, ce qu'on tape ne modifie pas la note. Chaque modification
// devient une PROPOSITION (revision : accepter ou refuser), visible par tous.
//
// Pendant la frappe, la modification en cours est gardee ici (« en attente ») :
// le texte remplace est barre, le texte tape s'affiche en vert juste apres,
// sans toucher au document partage. Elle part comme proposition (le « puits »
// donne par l'hote) quand on tape ailleurs, apres une pause, ou quand on
// quitte le mode.
//
// Regles de frappe (la note ne change pas, donc les positions non plus) :
//  - taper : s'ajoute au texte propose si le curseur est dans la plage en
//    attente, sinon ouvre une nouvelle proposition ;
//  - effacer : retire d'abord le texte propose ; ensuite, etend la plage
//    barree vers la gauche (Retour arriere) ou la droite (Suppr) ;
//  - remplacer une selection : la selection est barree, le texte tape la suit.
// Seules les frappes, collages et suppressions sont interceptes (userEvent
// input / delete) ; les modifications venues des autres membres passent.

import { Facet, StateEffect, StateField, EditorState, Transaction, type Extension, type TransactionSpec } from '@codemirror/state'
import { Decoration, EditorView, WidgetType, type DecorationSet } from '@codemirror/view'

/** Une proposition de modification : remplacer [from, to) du texte par `insert`. */
export interface TextProposal {
  from: number
  to: number
  insert: string
}

/** Ou partent les propositions (l'hote : revision de la note). */
export interface SuggestionSink {
  /** `read(from, to)` : le texte du document (tel qu'il est, il n'a pas change). */
  propose(change: TextProposal, read: (from: number, to: number) => string): void
}

/** Pause apres laquelle la modification en attente part en proposition. */
export const SUGGESTION_IDLE_MS = 2000

interface PendingState {
  sink: SuggestionSink | null
  pending: TextProposal | null
}

const setSink = StateEffect.define<SuggestionSink | null>()
const setPending = StateEffect.define<TextProposal | null>()

class InsertWidget extends WidgetType {
  constructor(private readonly text: string) { super() }
  eq(other: InsertWidget): boolean { return other.text === this.text }
  toDOM(): HTMLElement {
    const span = document.createElement('span')
    span.className = 'review-insert review-insert-pending'
    span.dataset.testid = 'suggestion-pending-insert'
    span.textContent = this.text
    return span
  }
  ignoreEvent(): boolean { return true }
}

const field = StateField.define<PendingState>({
  create: () => ({ sink: null, pending: null }),
  update(value, tr) {
    let next = value
    for (const e of tr.effects) {
      if (e.is(setSink)) next = { sink: e.value, pending: e.value ? next.pending : null }
      if (e.is(setPending)) next = { ...next, pending: e.value }
    }
    // Une modification venue d'ailleurs (autre membre) : la plage en attente suit.
    if (tr.docChanged && next.pending) {
      const from = tr.changes.mapPos(next.pending.from, 1)
      const to = Math.max(from, tr.changes.mapPos(next.pending.to, -1))
      next = { ...next, pending: { ...next.pending, from, to } }
    }
    return next
  },
  provide: f => EditorView.decorations.from(f, (s): DecorationSet => {
    const p = s.pending
    if (!p) return Decoration.none
    const decos = []
    if (p.to > p.from) decos.push(Decoration.mark({ class: 'review-delete review-delete-pending', attributes: { 'data-testid': 'suggestion-pending-delete' } }).range(p.from, p.to))
    if (p.insert) decos.push(Decoration.widget({ widget: new InsertWidget(p.insert), side: 1 }).range(p.to))
    return Decoration.set(decos, true)
  }),
})

const isTyping = (tr: Transaction): boolean =>
  tr.isUserEvent('input') || tr.isUserEvent('delete')

/** La plage en attente et la frappe, fusionnees ; null : une autre proposition commence. */
function merge(pending: TextProposal | null, change: TextProposal, backward: boolean): { pending: TextProposal; cursor: number } | null {
  const { from, to, insert } = change
  if (!pending) {
    return { pending: change, cursor: insert ? to : from }
  }
  const inside = (pos: number) => pos >= pending.from && pos <= pending.to
  if (insert) {
    // Frappe (ou remplacement de selection) dans la plage en attente.
    if (inside(from) && inside(to)) return { pending: { ...pending, insert: pending.insert + insert }, cursor: pending.to }
    return null
  }
  // Effacement. Le curseur est juste apres le texte propose (affiche apres la
  // plage) : Retour arriere en retire d'abord le dernier caractere.
  if (pending.insert && (inside(from) && inside(to) || (backward && to === pending.to))) {
    return { pending: { ...pending, insert: pending.insert.slice(0, -1) }, cursor: pending.to }
  }
  if (to === pending.from || (backward && inside(to))) {
    const a = Math.min(from, pending.from)
    return { pending: { ...pending, from: a }, cursor: a }
  }
  if (from === pending.to || (!backward && inside(from))) {
    const b = Math.max(to, pending.to)
    return { pending: { ...pending, to: b }, cursor: b }
  }
  return null
}


const sinkOf = (state: EditorState): SuggestionSink | null => {
  const s = state.field(field, false)
  if (s?.sink) return s.sink
  const getter = state.facet(dynamicSink)
  return getter ? getter() : null
}

/** Puits dynamique (editeurs des plugins) : lu a chaque frappe, quand aucun puits n'est pose. */
const dynamicSink = Facet.define<() => SuggestionSink | null, (() => SuggestionSink | null) | null>({
  combine: values => values[0] ?? null,
})

const interceptor = EditorState.transactionFilter.of(tr => {
  if (!tr.docChanged || !isTyping(tr)) return tr
  const state = tr.startState.field(field, false)
  const sink = sinkOf(tr.startState)
  if (!state || !sink) return tr

  // Les changements, en positions du document d'avant (il ne change pas).
  const changes: TextProposal[] = []
  tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
    changes.push({ from: fromA, to: toA, insert: inserted.toString() })
  })
  let pending = state.pending
  let cursor = tr.startState.selection.main.head
  const commits: TextProposal[] = []
  const backward = tr.isUserEvent('delete.backward')
  for (const change of changes) {
    const merged = merge(pending, change, backward)
    if (merged) { pending = merged.pending; cursor = merged.cursor; continue }
    if (pending && (pending.insert || pending.to > pending.from)) commits.push(pending)
    const fresh = merge(null, change, backward)!
    pending = fresh.pending
    cursor = fresh.cursor
  }
  const doc = tr.startState.doc
  const read = (a: number, b: number) => doc.sliceString(Math.max(0, a), Math.min(doc.length, b))
  for (const c of commits) sink.propose(c, read)
  const spec: TransactionSpec = {
    effects: setPending.of(pending && (pending.insert || pending.to > pending.from) ? pending : null),
    selection: { anchor: cursor },
    scrollIntoView: true,
  }
  return spec
})

/**
 * Le mode suggestion (inactif tant que l'hote ne donne pas de puits).
 * `getSink` : puits lu a chaque frappe (editeurs des plugins, mode global de
 * l'application) ; un puits pose par setSuggestionSink l'emporte.
 */
export function suggestionModeExtension(getSink?: () => SuggestionSink | null): Extension {
  let timer: ReturnType<typeof setTimeout> | null = null
  const idle = EditorView.updateListener.of(update => {
    const pending = update.state.field(field).pending
    const before = update.startState.field(field).pending
    if (pending === before) return
    if (timer) clearTimeout(timer)
    if (pending) timer = setTimeout(() => flushSuggestion(update.view), SUGGESTION_IDLE_MS)
  })
  const blur = EditorView.domEventHandlers({ blur: (_e, view) => { flushSuggestion(view); return false } })
  return [field, interceptor, idle, blur, ...(getSink ? [dynamicSink.of(getSink)] : [])]
}

/** Envoie la modification en attente (pause, perte du focus, sortie du mode). */
export function flushSuggestion(view: EditorView): void {
  const state = view.state.field(field, false)
  const sink = sinkOf(view.state)
  if (!state?.pending || !sink) return
  const pending = state.pending
  const doc = view.state.doc
  view.dispatch({ effects: setPending.of(null) })
  sink.propose(pending, (a, b) => doc.sliceString(Math.max(0, a), Math.min(doc.length, b)))
}

/** Active le mode suggestion (un puits) ou le coupe (null : la modification en attente part d'abord). */
export function setSuggestionSink(view: EditorView, sink: SuggestionSink | null): void {
  if (!sink) flushSuggestion(view)
  view.dispatch({ effects: setSink.of(sink) })
}

/** La modification en attente (tests, affichage). */
export function pendingSuggestion(state: EditorState): TextProposal | null {
  return state.field(field, false)?.pending ?? null
}
