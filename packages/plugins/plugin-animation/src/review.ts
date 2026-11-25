// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Revision liee au timecode : on commente un instant, une plage de temps, et
// si l'on veut un element de la scene a cet instant. Les commentaires sont
// ceux de la Revision (ReviewAPI.comment, cible AnimCommentTarget) : ils
// apparaissent aussi dans le panneau Revision, et s'y traitent pareil.
//
// Un clic sur un commentaire (ou sur son repere dans la frise) ramene la
// lecture a son timecode et fait clignoter l'element vise.
import type { PluginAPI, ReviewAnnotation } from '@savoire/plugin-api'
import { describeTarget, formatTimecode, isAnimTarget, type AnimCommentTarget } from './format'
import type { AnimationPlayer } from './player'
import type { Transport, TransportMarker } from './transport'

/** Les fils d'une animation : au timecode d'abord (dans l'ordre du temps), puis les autres. */
export function timecodeThreads(annotations: readonly ReviewAnnotation[]): { timed: (ReviewAnnotation & { target: AnimCommentTarget })[]; other: ReviewAnnotation[] } {
  const timed: (ReviewAnnotation & { target: AnimCommentTarget })[] = []
  const other: ReviewAnnotation[] = []
  for (const a of annotations) {
    if (a.kind !== 'comment' || a.status === 'rejected') continue
    if (isAnimTarget(a.target)) timed.push(a as ReviewAnnotation & { target: AnimCommentTarget })
    else if (a.target === undefined || a.target === null) other.push(a)
  }
  timed.sort((x, y) => x.target.start - y.target.start || (x.target.end ?? x.target.start) - (y.target.end ?? y.target.start))
  return { timed, other }
}

export class TimecodeReview {
  readonly el: HTMLElement
  private readonly list: HTMLElement
  private readonly draft: HTMLElement
  private readonly commentBtn: HTMLButtonElement
  private readonly rangeBtn: HTMLButtonElement
  private readonly pickBtn: HTMLButtonElement
  private rangeStart: number | null = null
  private element: { selector: string; label: string } | null = null
  private picking = false
  private cleanupDraft: (() => void) | null = null
  private cleanupCard: (() => void) | null = null
  private openCard: string | null = null
  private readonly unsubscribe: () => void

  constructor(private readonly api: PluginAPI | undefined, private readonly docId: string | undefined, private readonly player: AnimationPlayer, private readonly transport: Transport, private readOnly: boolean) {
    const el = document.createElement('div')
    el.className = 'anim-review'
    el.dataset.testid = 'anim-review'
    this.el = el
    const head = document.createElement('div')
    head.className = 'anim-review-head'
    const title = document.createElement('span')
    title.className = 'anim-review-title'
    title.textContent = 'Commentaires au timecode'
    const btn = (label: string, testid: string, run: () => void) => {
      const b = document.createElement('button')
      b.type = 'button'
      b.className = 'anim-btn'
      b.textContent = label
      b.dataset.testid = testid
      b.addEventListener('click', run)
      return b
    }
    this.rangeBtn = btn('Début de plage', 'anim-range', () => this.toggleRange())
    this.rangeBtn.title = 'Marquer le début d’une plage au temps actuel, puis avancer jusqu’à sa fin'
    this.pickBtn = btn('Viser un élément', 'anim-pick', () => this.togglePick())
    this.pickBtn.title = 'Cliquer ensuite sur un élément de la scène'
    this.commentBtn = btn('Commenter', 'anim-comment', () => this.startDraft())
    head.append(title, this.rangeBtn, this.pickBtn, this.commentBtn)
    this.draft = document.createElement('div')
    this.list = document.createElement('div')
    this.list.className = 'anim-review-list'
    el.append(head, this.draft, this.list)
    this.unsubscribe = api?.review?.onChange(() => this.refresh()) ?? (() => {})
    this.refresh()
  }

  setReadOnly(ro: boolean): void {
    this.readOnly = ro
    this.refresh()
  }

  /** Le temps a change : le libelle du bouton suit. */
  onTime(): void {
    const now = this.player.state.time
    const range = this.rangeStart !== null && now > this.rangeStart
    this.commentBtn.textContent = range ? `Commenter ${formatTimecode(this.rangeStart!)} → ${formatTimecode(now)}` : `Commenter à ${formatTimecode(now)}`
  }

  /** Un element a ete choisi dans la scene. */
  onPicked(selector: string, label: string): void {
    this.picking = false
    this.player.pick(false)
    this.element = { selector, label }
    this.pickBtn.textContent = `Élément : ${label} ✕`
    this.pickBtn.classList.add('anim-btn-on')
    this.player.mark(selector)
  }

  dispose(): void {
    this.unsubscribe()
    this.cleanupDraft?.()
    this.cleanupCard?.()
  }

  private toggleRange(): void {
    if (this.rangeStart === null) {
      this.rangeStart = this.player.state.time
      this.rangeBtn.textContent = `Plage depuis ${formatTimecode(this.rangeStart)} ✕`
      this.rangeBtn.classList.add('anim-btn-on')
    } else {
      this.rangeStart = null
      this.rangeBtn.textContent = 'Début de plage'
      this.rangeBtn.classList.remove('anim-btn-on')
    }
    this.onTime()
  }

  private togglePick(): void {
    if (this.element) {
      this.element = null
      this.pickBtn.textContent = 'Viser un élément'
      this.pickBtn.classList.remove('anim-btn-on')
      return
    }
    this.picking = !this.picking
    this.player.pick(this.picking)
    this.pickBtn.classList.toggle('anim-btn-on', this.picking)
    this.pickBtn.textContent = this.picking ? 'Cliquez dans la scène…' : 'Viser un élément'
  }

  private target(): AnimCommentTarget {
    const now = Math.round(this.player.state.time)
    const start = this.rangeStart !== null ? Math.min(this.rangeStart, now) : now
    const end = this.rangeStart !== null && now !== this.rangeStart ? Math.max(this.rangeStart, now) : undefined
    return {
      kind: 'anim.time', start,
      ...(end !== undefined ? { end } : {}),
      ...(this.element ? { element: this.element.selector, elementLabel: this.element.label } : {}),
    }
  }

  private startDraft(): void {
    const review = this.api?.review
    if (!review?.renderDraft || !this.docId || this.readOnly) return
    this.player.pause()
    this.transport.update()
    this.cleanupDraft?.()
    const target = this.target()
    // Une boite par brouillon : la carte la met en forme, elle part avec lui.
    const box = document.createElement('div')
    this.draft.replaceChildren(box)
    this.cleanupDraft = review.renderDraft(box, { docId: this.docId, kind: 'comment', quote: describeTarget(target), target }, {
      onDone: () => {
        this.cleanupDraft?.()
        this.cleanupDraft = null
        box.remove()
        // Plage et element servent a un commentaire ; le suivant repart de zero.
        if (this.rangeStart !== null) this.toggleRange()
        if (this.element) this.togglePick()
        this.refresh()
      },
    })
  }

  /** Va au timecode d'un fil et ouvre sa carte. */
  private goTo(a: ReviewAnnotation & { target: AnimCommentTarget }): void {
    this.player.seek(a.target.start)
    this.transport.update()
    if (a.target.element) this.player.mark(a.target.element)
    this.showCard(a.id)
  }

  private showCard(id: string): void {
    const review = this.api?.review
    this.cleanupCard?.()
    this.cleanupCard = null
    if (this.openCard === id || !review?.renderAnnotation) { this.openCard = null; this.refresh(); return }
    this.openCard = id
    this.refresh()
  }

  refresh(): void {
    const review = this.api?.review
    const disabled = !review?.renderDraft || !this.docId || this.readOnly
    for (const b of [this.commentBtn, this.rangeBtn, this.pickBtn]) b.disabled = disabled
    this.onTime()
    this.cleanupCard?.()
    this.cleanupCard = null
    this.list.replaceChildren()
    if (!review || !this.docId) {
      this.list.append(Object.assign(document.createElement('div'), { className: 'anim-empty', textContent: 'La révision n’est pas disponible pour cette animation.' }))
      this.transport.setMarkers([])
      return
    }
    const { timed, other } = timecodeThreads(review.annotations(this.docId))
    const markers: TransportMarker[] = timed.map(a => ({
      id: a.id, start: a.target.start, ...(a.target.end !== undefined ? { end: a.target.end } : {}),
      title: `${describeTarget(a.target)} : ${a.text}`, resolved: a.status !== 'open',
    }))
    this.transport.setMarkers(markers)
    if (!timed.length && !other.length) {
      this.list.append(Object.assign(document.createElement('div'), {
        className: 'anim-empty',
        textContent: 'Aucun commentaire. Mettez la lecture en pause à l’instant voulu, puis « Commenter ».',
      }))
    }
    const item = (a: ReviewAnnotation, when: string, onClick: () => void) => {
      const row = document.createElement('div')
      row.className = `anim-comment${a.status !== 'open' ? ' anim-comment-done' : ''}`
      row.dataset.testid = 'anim-comment-item'
      const w = document.createElement('span')
      w.className = 'anim-comment-when'
      w.textContent = when
      const body = document.createElement('div')
      body.className = 'anim-comment-body'
      const meta = document.createElement('div')
      meta.className = 'anim-comment-meta'
      meta.textContent = `${a.authorName}${a.byAgent ? ' (IA)' : ''}${a.replies.length ? ` · ${a.replies.length} réponse(s)` : ''}${a.status === 'resolved' ? ' · résolu' : ''}`
      const text = document.createElement('div')
      text.className = 'anim-comment-text'
      text.textContent = a.text
      body.append(meta, text)
      row.append(w, body)
      row.addEventListener('click', onClick)
      this.list.appendChild(row)
      if (this.openCard === a.id && review.renderAnnotation) {
        const card = document.createElement('div')
        card.className = 'anim-card'
        this.list.appendChild(card)
        this.cleanupCard = review.renderAnnotation([a.id], card, { onDone: () => { this.openCard = null; this.refresh() } })
      }
    }
    for (const a of timed) {
      const t = a.target
      const when = t.end !== undefined && t.end > t.start ? `${formatTimecode(t.start)} → ${formatTimecode(t.end)}` : formatTimecode(t.start)
      item(a, t.elementLabel ? `${when} · ${t.elementLabel}` : when, () => this.goTo(a))
    }
    for (const a of other) item(a, 'Toute l’animation', () => this.showCard(a.id))
  }
}
