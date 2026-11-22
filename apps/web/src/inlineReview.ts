// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// La revision dans la note (Plume) : les passages commentes et les
// suggestions sont surlignes dans le texte ; un clic ouvre leur carte
// par-dessus la note (AnnotationCard), ou l'on repond, accepte, refuse,
// resout, sans ouvrir le panneau Revision. « Commenter » et « Suggérer » sur
// la selection ouvrent aussi leur brouillon dans la note.
//
// La personne choisit (isInlineReview) : sans annotations dans la note, les
// passages ne sont surlignes que quand le panneau Revision est ouvert, comme
// avant.
import type { AnnotationHost, EditorController, EditorHighlight } from '@savoire/editor-core'
import { ReviewService, describeActor, type IVaultSyncSession, type UserActor } from '@savoire/application'
import { renderAnnotationCard, renderDraftCard } from './AnnotationCard'
import { annotationCardDeps, isInlineReview, onInlineReviewChange, reviewFor, withReviewText } from './reviewProposals'

export interface InlineReviewContext {
  editor: EditorController | null
  docId(): string | undefined
  session(): IVaultSyncSession | undefined
  actor(): UserActor | undefined
  canWrite(): boolean
  /** Ouvrir le panneau Revision. */
  openPanel(): void
}

let ctx: InlineReviewContext | null = null
/** Panneaux Revision ouverts : ils veulent les passages surlignes, meme sans annotations dans la note. */
let panels = 0
let watched: IVaultSyncSession | undefined
let stopWatching: (() => void) | null = null
/** L'editeur a qui l'on a donne l'hote des cartes. */
let hosted: EditorController | null = null

const host: AnnotationHost = {
  render(ids, dom, close) {
    const session = ctx?.session()
    if (!ctx || !session) return () => {}
    return renderAnnotationCard(dom, ids, annotationCardDeps(session, ctx.actor, ctx.canWrite, ctx.openPanel), close)
  },
  renderDraft(draft, dom, close) {
    const context = ctx
    const session = context?.session()
    const docId = context?.docId()
    if (!context || !session || !docId) return () => {}
    // Ancre tout de suite : le passage suivra ce que les autres modifient pendant qu'on ecrit.
    const anchor = withReviewText(session, docId, text => ReviewService.anchor(text, draft.from, draft.to))
    if (!anchor) { close(); return () => {} }
    return renderDraftCard(dom, { kind: draft.kind, quote: anchor.quote }, (text, replacement) => {
      const me = context.actor()
      if (!me || !context.canWrite()) throw new Error('Lecture seule : vous ne pouvez pas commenter.')
      const review = reviewFor(session)
      if (draft.kind === 'suggestion') review.suggest(docId, anchor, replacement, me, text)
      else review.comment(docId, text, me, anchor)
    }, close)
  },
}

/** Les passages de la note a surligner : fils ouverts, ancres dans le texte. */
export function noteHighlights(session: IVaultSyncSession, docId: string, clickable: boolean): EditorHighlight[] {
  const review = reviewFor(session)
  const where = clickable ? 'cliquer pour ouvrir' : 'panneau Révision'
  return withReviewText(session, docId, text => review.threads(docId)
    .filter(t => t.root.anchor && (t.root.status ?? 'open') === 'open')
    .flatMap(t => {
      const at = ReviewService.locate(t.root.anchor!, text)
      const isSuggestion = t.root.kind === 'suggestion'
      // Une suggestion d'ajout n'a pas de texte remplace : plage vide, texte propose seul.
      if (!at || !(at.to > at.from || (isSuggestion && t.root.replacement))) return []
      return [{
        from: at.from, to: at.to, id: t.root.id,
        className: isSuggestion ? 'review-mark review-mark-suggestion' : 'review-mark',
        title: isSuggestion ? `Suggestion de ${describeActor(t.root.author)} (${where})` : `Commentaire : ${t.root.text.slice(0, 80)}`,
        ...(isSuggestion && t.root.replacement ? { insert: t.root.replacement } : {}),
      }]
    })) ?? []
}

function refresh(): void {
  const session = ctx?.session()
  if (session !== watched) {
    stopWatching?.()
    stopWatching = null
    watched = session
    if (session) stopWatching = reviewFor(session).onChange(refresh)
  }
  const editor = ctx?.editor ?? null
  if (!editor) return
  const inline = isInlineReview()
  const wantHost = inline && !!session
  if (wantHost && hosted !== editor) { editor.setAnnotationHost?.(host); hosted = editor }
  if (!wantHost && hosted === editor) { editor.setAnnotationHost?.(null); hosted = null }
  const docId = ctx!.docId()
  if (!session || !docId || (!inline && panels === 0)) { editor.setHighlights?.([]); return }
  editor.setHighlights?.(noteHighlights(session, docId, inline))
}

onInlineReviewChange(refresh)

/** L'editeur de notes actif (appele a chaque changement d'editeur). */
export function setInlineReviewEditor(context: InlineReviewContext): void {
  if (hosted && hosted !== context.editor) {
    // L'ancien editeur peut deja etre detruit.
    try { hosted.setAnnotationHost?.(null) } catch { /* rien a retirer */ }
    hosted = null
  }
  ctx = context
  refresh()
}

/** Le panneau Revision s'ouvre : il veut voir ses passages surlignes. Rend sa fermeture. */
export function showReviewHighlights(): () => void {
  panels++
  refresh()
  let done = false
  return () => { if (done) return; done = true; panels--; refresh() }
}

/** Recalcule les passages (vault change, note rechargee). */
export function refreshInlineReview(): void {
  refresh()
}

/**
 * « Commenter » / « Suggérer » sur la selection, dans la note. False : pas
 * d'annotations dans la note, pas de selection, ou editeur sans cartes (le
 * panneau Revision prend alors le relais).
 */
export function openInlineDraft(kind: 'comment' | 'suggestion', from: number, to: number): boolean {
  if (!isInlineReview() || to <= from || !ctx?.editor?.openAnnotationDraft || !ctx.session() || !ctx.canWrite()) return false
  refresh()
  return ctx.editor.openAnnotationDraft({ kind, from, to })
}
