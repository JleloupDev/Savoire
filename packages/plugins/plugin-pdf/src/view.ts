// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// La vue d'un PDF dans Savoire : les pages dessinees par pdf.js, avec leur
// texte selectionnable, et par-dessus ce que la Revision y a pose.
//
//  - Surligner : selectionner du texte (ou tracer une zone), choisir une couleur.
//  - Ancrer : nommer un passage, une zone ou une page pour le citer ailleurs ;
//    son lien ([[Rapport.pdf#^ref]], [[Rapport.pdf#page=3]]) se copie et
//    ramene ici, a la bonne place.
//  - Commenter : un fil de la Revision sur le passage, la zone ou une marque.
// Tout passe par la Revision (api.review) : fils, reponses, statut, et qui a
// fait quoi. Le fichier n'est jamais reecrit.
//
// Pages scannees : le texte reconnu (OCR) est pose sous l'image, mot a mot ;
// on le selectionne et le surligne comme l'autre. Lu dans l'annexe « ocr »
// du PDF, ou reconnu ici puis ecrit dans l'annexe pour tout le monde.
//
// Ce que la personne selectionne ou montre (une marque) part au contexte de
// l'IA (workspace.reportContext) : get_context le rend a ChatGPT ou Claude.
import {
  PDF_COLORS, describePdfTarget, isPdfTarget, locatePdfQuote, newPdfRef, normalizePdfRects, parsePdfOcrPage, parsePdfSubpath,
  pdfOcrKey, pdfOcrText, pdfRectsBounds, pdfWikiLink, PDF_OCR_ANNEX, PDF_SIDE_CHARS, MAX_PDF_QUOTE,
  type FileContext, type FileView, type ISharedTree, type PdfColor, type PdfOcrPage, type PdfRect, type PdfTarget, type PluginAPI, type ReviewAnnotation,
} from '@savoire/plugin-api'
import { MIN_PAGE_TEXT, ocrEnabled, ocrPdfPage } from './ocr'
import { loadPdfJs, openPdf, type PdfDocument, type PdfJs } from './pdfjs'
import { ensurePdfViewStyle } from './style'

type Ann = ReviewAnnotation & { target: PdfTarget }

interface Slot {
  n: number
  el: HTMLDivElement
  canvas: HTMLCanvasElement
  text: HTMLDivElement
  marks: HTMLDivElement
  /** Taille de la page a l'echelle 1 (points). */
  w: number
  h: number
  /** Echelle du dernier dessin (0 : pas dessinee). */
  drawn: number
  drawing: Promise<void> | null
  task: { cancel(): void } | null
  /** Le texte de la page (pdf.js, ou reconnu). */
  content: string
  scanned: boolean
  ocr: PdfOcrPage | null
}

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag)
  if (cls) e.className = cls
  if (text !== undefined) e.textContent = text
  return e
}

const squashSpaces = (s: string) => s.replace(/\s+/g, ' ').trim()
const MIN_SCALE = 0.4
const MAX_SCALE = 4

export function createPdfView(path: string, ctx: FileContext, api?: PluginAPI): FileView {
  let viewer: PdfViewer | null = null
  return {
    mount(container: HTMLElement) {
      viewer?.destroy()
      viewer = new PdfViewer(path, ctx, api, container)
    },
    setReadOnly(readOnly: boolean) {
      viewer?.setReadOnly(readOnly)
      return true
    },
    destroy() {
      viewer?.destroy()
      viewer = null
    },
  } as FileView
}

class PdfViewer {
  private readonly root: HTMLDivElement
  private readonly scroller: HTMLDivElement
  private readonly pagesEl: HTMLDivElement
  private readonly side: HTMLDivElement
  private readonly status: HTMLSpanElement
  private readonly pageInput: HTMLInputElement
  private readonly pageCount: HTMLSpanElement
  private readonly zoomLabel: HTMLSpanElement
  private readonly zoneBtn: HTMLButtonElement
  private readonly sideBtn: HTMLButtonElement
  private readonly docId: string | undefined
  private lib: PdfJs | null = null
  private doc: PdfDocument | null = null
  private destroyDoc: (() => Promise<void>) | null = null
  private fp = ''
  private slots: Slot[] = []
  private scale = 1
  private fitWidth = true
  private dead = false
  private readOnly: boolean
  private zoning = false
  /** Le clic qui suit le trace d'une zone ne ferme pas son menu. */
  private swallowClick = false
  private observer: IntersectionObserver | null = null
  private visible = new Set<number>()
  private anns: Ann[] = []
  private pop: HTMLDivElement | null = null
  private popCleanup: (() => void) | null = null
  private focusId: string | null = null
  private ocrTree: ISharedTree | null = null
  private ocrQueue: number[] = []
  private ocrRunning = false
  private ocrFailed = false
  private pendingReveal: string | null = null
  private reportTimer: ReturnType<typeof setTimeout> | null = null
  private readonly offs: (() => void)[] = []
  /** Rectangles retrouves par le texte, quand le fichier a change depuis la marque (id -> rectangles). */
  private relocated = new Map<string, { page: number; rects: PdfRect[] } | null>()

  constructor(private readonly path: string, private readonly ctx: FileContext, private readonly api: PluginAPI | undefined, container: HTMLElement) {
    ensurePdfViewStyle()
    this.readOnly = !!ctx.readOnly
    this.docId = (ctx.vault ?? api?.vault)?.resolveDocumentId?.(path) ?? undefined
    container.replaceChildren()
    container.style.cssText = 'height:100%;overflow:hidden'
    this.root = el('div', 'pdfv')
    this.root.dataset.testid = 'pdf-view'
    const bar = el('div', 'pdfv-bar')
    const btn = (label: string, title: string, run: () => void, testid?: string) => {
      const b = el('button', 'pdfv-btn', label)
      b.type = 'button'
      b.title = title
      if (testid) b.dataset.testid = testid
      b.addEventListener('click', run)
      return b
    }
    this.pageInput = el('input', 'pdfv-pagein')
    this.pageInput.value = '1'
    this.pageInput.setAttribute('aria-label', 'Page')
    this.pageInput.addEventListener('change', () => this.goToPage(Number(this.pageInput.value) || 1))
    this.pageCount = el('span', undefined, '/ …')
    this.zoomLabel = el('span', undefined, '100 %')
    this.zoneBtn = btn('Zone', 'Tracer une zone (aussi : Alt + glisser)', () => this.setZoning(!this.zoning), 'pdf-zone')
    this.sideBtn = btn('Annotations', 'Surlignages, ancres et commentaires de ce PDF', () => this.toggleSide(), 'pdf-side-toggle')
    this.status = el('span', 'pdfv-status')
    this.status.dataset.testid = 'pdf-status'
    bar.append(
      btn('‹', 'Page précédente', () => this.goToPage(this.currentPage() - 1)), this.pageInput, this.pageCount,
      btn('›', 'Page suivante', () => this.goToPage(this.currentPage() + 1)),
      el('span', 'pdfv-sep'),
      btn('−', 'Réduire', () => this.zoom(this.scale / 1.2)), this.zoomLabel, btn('+', 'Agrandir', () => this.zoom(this.scale * 1.2)),
      btn('Largeur', 'Ajuster à la largeur', () => { this.fitWidth = true; this.zoom(this.widthScale()) }),
      el('span', 'pdfv-sep'),
      this.zoneBtn,
      btn('Lien de la page', 'Copier le lien vers cette page', () => { void this.copyLink({ page: this.currentPage() }) }, 'pdf-page-link'),
      this.sideBtn,
      this.status,
    )
    const main = el('div', 'pdfv-main')
    this.scroller = el('div', 'pdfv-scroll')
    this.scroller.dataset.testid = 'pdf-scroll'
    this.pagesEl = el('div', 'pdfv-pages')
    this.scroller.appendChild(this.pagesEl)
    this.side = el('div', 'pdfv-side')
    this.side.style.display = 'none'
    this.side.dataset.testid = 'pdf-side'
    main.append(this.scroller, this.side)
    this.root.append(bar, main)
    container.appendChild(this.root)

    this.scroller.addEventListener('scroll', () => { this.onScroll() }, { passive: true })
    this.scroller.addEventListener('mouseup', e => this.onMouseUp(e))
    this.scroller.addEventListener('mousedown', e => this.onMouseDown(e))
    this.scroller.addEventListener('click', e => this.onClick(e))
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { this.closePop(); if (this.zoning) this.setZoning(false) } }
    this.root.addEventListener('keydown', onKey)
    this.root.tabIndex = -1

    const offReview = api?.review?.onChange(() => this.refreshAnns())
    if (offReview) this.offs.push(offReview)
    const offReveal = api?.workspace?.subscribeReveal?.((p, sub) => { if (p === this.path) this.reveal(sub) })
    if (offReveal) this.offs.push(offReveal)
    this.pendingReveal = api?.workspace?.takeReveal?.(path) ?? null
    const onResize = () => { if (this.fitWidth && this.slots.length) this.zoom(this.widthScale(), true) }
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(onResize) : null
    ro?.observe(this.scroller)
    if (ro) this.offs.push(() => ro.disconnect())

    void this.load().catch(err => {
      if (!this.dead) this.pagesEl.replaceChildren(el('div', 'pdfv-msg', `PDF illisible : ${err instanceof Error ? err.message : String(err)}`))
    })
  }

  setReadOnly(ro: boolean): void {
    this.readOnly = ro
    this.closePop()
  }

  destroy(): void {
    this.dead = true
    this.closePop()
    for (const off of this.offs.splice(0)) off()
    this.observer?.disconnect()
    for (const s of this.slots) s.task?.cancel()
    if (this.reportTimer) clearTimeout(this.reportTimer)
    if (this.ocrTree) this.ctx.shared?.closeTree?.(PDF_OCR_ANNEX)
    void this.destroyDoc?.()
  }

  private canWrite(): boolean {
    return !this.readOnly && !!this.docId && !!this.api?.review
  }

  // ── Chargement et dessin ──────────────────────────────────────────────────

  private async load(): Promise<void> {
    this.pagesEl.replaceChildren(el('div', 'pdfv-msg', 'Ouverture du PDF…'))
    const bytes = await (this.ctx.vault ?? this.api?.vault)?.readBinary?.(this.path)
    if (this.dead) return
    if (!bytes) { this.pagesEl.replaceChildren(el('div', 'pdfv-msg', 'Les octets de ce PDF ne sont pas disponibles ici.')); return }
    this.lib = await loadPdfJs()
    const { doc, destroy } = await openPdf(bytes, true)
    if (this.dead) { void destroy(); return }
    this.doc = doc
    this.destroyDoc = destroy
    this.fp = doc.fingerprints[0] ?? ''
    // Les tailles de toutes les pages d'abord (une page de travers n'a pas la taille des autres).
    const first = await doc.getPage(1)
    const vp1 = first.getViewport({ scale: 1 })
    this.pagesEl.replaceChildren()
    for (let n = 1; n <= doc.numPages; n++) {
      const slot = this.makeSlot(n, vp1.width, vp1.height)
      this.slots.push(slot)
      this.pagesEl.appendChild(slot.el)
    }
    this.pageCount.textContent = `/ ${doc.numPages}`
    this.scale = this.widthScale()
    this.layout()
    void this.sizePages()
    this.observer = new IntersectionObserver(entries => {
      for (const e of entries) {
        const n = Number((e.target as HTMLElement).dataset.page)
        if (e.isIntersecting) this.visible.add(n)
        else this.visible.delete(n)
      }
      this.drawVisible()
    }, { root: this.scroller, rootMargin: '600px 0px' })
    for (const s of this.slots) this.observer.observe(s.el)
    await this.openOcr()
    this.refreshAnns()
    if (this.pendingReveal) { const sub = this.pendingReveal; this.pendingReveal = null; this.reveal(sub) }
    // L'IA sait que la personne lit ce PDF, meme sans selection.
    this.scheduleReport()
  }

  private makeSlot(n: number, w: number, h: number): Slot {
    const page = el('div', 'pdfv-page')
    page.dataset.page = String(n)
    page.dataset.testid = 'pdf-page'
    const canvas = el('canvas')
    const marks = el('div', 'pdfv-marks')
    const text = el('div', 'textLayer')
    page.append(canvas, marks, text, el('span', 'pdfv-num', String(n)))
    return { n, el: page, canvas, text, marks, w, h, drawn: 0, drawing: null, task: null, content: '', scanned: false, ocr: null }
  }

  /** La vraie taille de chaque page (sans la dessiner). */
  private async sizePages(): Promise<void> {
    const doc = this.doc
    if (!doc) return
    let changed = false
    for (const s of this.slots) {
      if (this.dead) return
      const page = await doc.getPage(s.n)
      const vp = page.getViewport({ scale: 1 })
      if (Math.abs(vp.width - s.w) > 0.5 || Math.abs(vp.height - s.h) > 0.5) { s.w = vp.width; s.h = vp.height; changed = true }
    }
    if (changed) this.layout()
  }

  private widthScale(): number {
    const w = (this.scroller.clientWidth || 800) - 40
    const widest = Math.max(1, ...this.slots.map(s => s.w))
    return Math.max(MIN_SCALE, Math.min(MAX_SCALE, w / widest))
  }

  private layout(): void {
    for (const s of this.slots) {
      s.el.style.width = `${Math.floor(s.w * this.scale)}px`
      s.el.style.height = `${Math.floor(s.h * this.scale)}px`
      s.el.style.setProperty('--total-scale-factor', String(this.scale))
      s.el.style.setProperty('--scale-factor', String(this.scale))
    }
    this.zoomLabel.textContent = `${Math.round(this.scale * 100)} %`
  }

  private zoom(next: number, keepFit = false): void {
    const scale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, next))
    if (!keepFit && next !== this.widthScale()) this.fitWidth = false
    if (Math.abs(scale - this.scale) < 0.005) return
    // Garder la meme page sous les yeux.
    const page = this.currentPage()
    const slot = this.slots[page - 1]
    const within = slot ? (this.scroller.scrollTop - slot.el.offsetTop) / Math.max(1, slot.el.offsetHeight) : 0
    this.scale = scale
    this.layout()
    if (slot) this.scroller.scrollTop = slot.el.offsetTop + within * slot.el.offsetHeight
    this.closePop()
    this.drawVisible()
  }

  private drawVisible(): void {
    for (const n of this.visible) {
      const s = this.slots[n - 1]
      if (s && s.drawn !== this.scale && !s.drawing) s.drawing = this.draw(s).finally(() => { s.drawing = null; if (s.drawn !== this.scale && this.visible.has(s.n)) this.drawVisible() })
    }
  }

  private async draw(s: Slot): Promise<void> {
    const doc = this.doc, lib = this.lib
    if (!doc || !lib || this.dead) return
    const scale = this.scale
    const page = await doc.getPage(s.n)
    const viewport = page.getViewport({ scale })
    const dpr = Math.min(2, globalThis.devicePixelRatio || 1)
    const canvas = el('canvas')
    canvas.width = Math.floor(viewport.width * dpr)
    canvas.height = Math.floor(viewport.height * dpr)
    canvas.style.width = `${Math.floor(viewport.width)}px`
    canvas.style.height = `${Math.floor(viewport.height)}px`
    s.task?.cancel()
    const task = page.render({ canvas, viewport, ...(dpr !== 1 ? { transform: [dpr, 0, 0, dpr, 0, 0] } : {}) })
    s.task = task
    try {
      await task.promise
    } catch (err) {
      if ((err as { name?: string })?.name === 'RenderingCancelledException') return
      throw err
    } finally {
      if (s.task === task) s.task = null
    }
    if (this.dead || scale !== this.scale) return
    s.canvas.replaceWith(canvas)
    s.canvas = canvas
    // Le texte : celui du PDF, sinon (page scannee) celui de l'OCR.
    const content = await page.getTextContent()
    const items = content.items as { str?: string; hasEOL?: boolean }[]
    let text = ''
    for (const it of items) if (typeof it.str === 'string') text += it.str + (it.hasEOL ? '\n' : '')
    s.content = text
    s.scanned = squashSpaces(text).length < MIN_PAGE_TEXT
    const layer = el('div', s.scanned ? 'pdfv-ocr' : 'textLayer')
    s.text.replaceWith(layer)
    s.text = layer
    if (!s.scanned) {
      await new lib.TextLayer({ textContentSource: content, container: layer, viewport }).render()
      layer.appendChild(el('div', 'endOfContent'))
    } else {
      this.ensureOcr(s)
      if (s.ocr) this.buildOcrLayer(s)
    }
    s.drawn = scale
    page.cleanup()
    this.drawMarks(s)
  }

  // ── Texte reconnu (OCR) ───────────────────────────────────────────────────

  private async openOcr(): Promise<void> {
    const open = this.ctx.shared?.openTree
    if (!open) return
    try {
      this.ocrTree = await open(PDF_OCR_ANNEX)
    } catch {
      return
    }
    if (this.dead) return
    // Un autre membre a reconnu une page : on la prend.
    this.offs.push(this.ocrTree.onChange(() => {
      for (const s of this.slots) if (s.scanned && !s.ocr && s.drawn) { this.ensureOcr(s); if (s.ocr) { this.buildOcrLayer(s); this.drawMarks(s) } }
    }))
    for (const s of this.slots) if (s.scanned && s.drawn && !s.ocr) { this.ensureOcr(s); if (s.ocr) { this.buildOcrLayer(s); this.drawMarks(s) } }
  }

  /** Le texte reconnu de la page : deja garde dans l'annexe, sinon a reconnaitre (en file). */
  private ensureOcr(s: Slot): void {
    if (s.ocr) return
    const kept = parsePdfOcrPage(this.ocrTree?.root.get(pdfOcrKey(s.n)))
    if (kept && (!kept.fp || !this.fp || kept.fp === this.fp)) {
      s.ocr = kept
      s.content = pdfOcrText(kept)
      return
    }
    if (!ocrEnabled() || this.ocrFailed || this.ocrQueue.includes(s.n)) return
    this.ocrQueue.push(s.n)
    void this.runOcr()
  }

  private async runOcr(): Promise<void> {
    if (this.ocrRunning) return
    this.ocrRunning = true
    try {
      while (this.ocrQueue.length && !this.dead && this.doc) {
        // Les pages sous les yeux d'abord.
        this.ocrQueue.sort((a, b) => Number(this.visible.has(b)) - Number(this.visible.has(a)) || a - b)
        const n = this.ocrQueue.shift()!
        const s = this.slots[n - 1]
        if (!s || s.ocr) continue
        this.status.textContent = `Lecture du texte de la page ${n} (OCR)…`
        try {
          const page = await ocrPdfPage(this.doc, n)
          if (this.dead) return
          s.ocr = page
          s.content = pdfOcrText(page)
          // Pour tout le monde : une fois reconnue, la page ne se relit plus.
          if (this.ocrTree && !this.readOnly) this.ocrTree.transact(() => { this.ocrTree!.root.set(pdfOcrKey(n), JSON.stringify(page)) })
          if (s.drawn) { this.buildOcrLayer(s); this.drawMarks(s) }
        } catch (err) {
          console.warn('[plugin-pdf] OCR impossible', n, err)
          this.ocrFailed = true
          this.ocrQueue = []
          this.status.textContent = 'Texte de la page scannée illisible ici (OCR indisponible).'
          return
        }
      }
      if (!this.dead) this.status.textContent = this.slots.some(s => s.ocr) ? 'Texte des pages scannées reconnu (OCR).' : ''
    } finally {
      this.ocrRunning = false
    }
  }

  /** Les mots reconnus, chacun a sa place, transparents : on les selectionne comme du texte. */
  private buildOcrLayer(s: Slot): void {
    const ocr = s.ocr
    if (!ocr) return
    const layer = el('div', 'pdfv-ocr')
    const pw = s.w * this.scale, ph = s.h * this.scale
    const measure = document.createElement('canvas').getContext('2d')
    const starts = new Set(ocr.lines)
    ocr.words.forEach((w, i) => {
      const lastOfLine = starts.has(i + 1) || i === ocr.words.length - 1
      const span = el('span', undefined, w.t + (lastOfLine ? '' : ' '))
      const fs = Math.max(4, w.b[3] * ph)
      span.style.left = `${w.b[0] * pw}px`
      span.style.top = `${w.b[1] * ph}px`
      span.style.fontSize = `${fs}px`
      if (measure) {
        measure.font = `${fs}px sans-serif`
        const natural = measure.measureText(w.t).width
        if (natural > 0) span.style.transform = `scaleX(${(w.b[2] * pw) / natural})`
      }
      layer.appendChild(span)
      if (lastOfLine) layer.appendChild(el('br'))
    })
    s.text.replaceWith(layer)
    s.text = layer
  }

  // ── Les marques de la Revision ────────────────────────────────────────────

  private refreshAnns(): void {
    const review = this.api?.review
    if (!review || !this.docId) { this.anns = []; this.renderSide(); return }
    this.anns = review.annotations(this.docId)
      .filter((a): a is Ann => a.kind === 'comment' && isPdfTarget(a.target) && a.status !== 'rejected')
      .sort((a, b) => a.target.page - b.target.page || (a.target.rects[0]?.[1] ?? 0) - (b.target.rects[0]?.[1] ?? 0))
    this.relocated.clear()
    for (const s of this.slots) if (s.drawn) this.drawMarks(s)
    this.renderSide()
  }

  /** Ou est une marque aujourd'hui : sa place, ou (autre version du fichier) celle de son texte. */
  private placeOf(a: Ann): { page: number; rects: PdfRect[] } | null {
    const t = a.target
    if (!t.fp || !this.fp || t.fp === this.fp || !t.quote.trim()) return { page: t.page, rects: t.rects }
    if (this.relocated.has(a.id)) return this.relocated.get(a.id)!
    const texts = this.slots.map(s => s.content)
    const found = locatePdfQuote(texts, t, t.page)
    if (!found) { this.relocated.set(a.id, null); return null }
    const slot = this.slots[found.page - 1]
    if (!slot?.drawn) return { page: found.page, rects: [] }
    const rects = this.rectsForQuote(slot, t.quote)
    const place = { page: found.page, rects }
    this.relocated.set(a.id, place)
    return place
  }

  private drawMarks(s: Slot): void {
    s.marks.replaceChildren()
    for (const a of this.anns) {
      const place = this.placeOf(a)
      if (!place || place.page !== s.n) continue
      const t = a.target
      const rects = place.rects.length ? place.rects : [[0, 0, 1, 1] as PdfRect]
      const cls = t.mark === 'highlight' ? 'hl' : t.mark === 'anchor' ? 'anchor' : 'comment'
      for (const r of rects) {
        const m = el('div', `pdfv-mark ${cls}${t.zone ? ' zone' : ''}${this.focusId === a.id ? ' focus' : ''}`)
        m.dataset.id = a.id
        m.dataset.testid = 'pdf-mark'
        m.style.left = `${r[0] * 100}%`
        m.style.top = `${r[1] * 100}%`
        m.style.width = `${r[2] * 100}%`
        m.style.height = `${r[3] * 100}%`
        if (t.mark === 'highlight') m.style.background = PDF_COLORS[t.color ?? 'jaune'] ?? PDF_COLORS.jaune
        if (a.status === 'resolved' && !t.mark) m.style.opacity = '.4'
        s.marks.appendChild(m)
      }
      const box = pdfRectsBounds(rects)!
      if (t.mark === 'anchor') {
        // Dans la marge, a gauche du passage : le texte au-dessus reste lisible.
        const flag = el('div', 'pdfv-flag', '⚑')
        flag.title = `Ancre : ${t.label || 'sans nom'}`
        flag.style.left = `${box[0] * 100}%`
        flag.style.top = `${box[1] * 100}%`
        s.marks.appendChild(flag)
      }
      if (a.text.trim() || a.replies.length) {
        const bubble = el('div', 'pdfv-bubble', '💬')
        bubble.style.left = `${(box[0] + box[2]) * 100}%`
        bubble.style.top = `${(box[1] + Math.min(box[3], 0.02)) * 100}%`
        s.marks.appendChild(bubble)
      }
    }
  }

  private flash(id: string): void {
    for (const m of Array.from(this.root.querySelectorAll<HTMLElement>(`.pdfv-mark[data-id="${CSS.escape(id)}"]`))) {
      m.classList.remove('flash')
      void m.offsetWidth
      m.classList.add('flash')
    }
  }

  // ── Panneau des annotations ───────────────────────────────────────────────

  private toggleSide(): void {
    const open = this.side.style.display === 'none'
    this.side.style.display = open ? '' : 'none'
    this.sideBtn.classList.toggle('on', open)
    if (this.fitWidth) requestAnimationFrame(() => this.zoom(this.widthScale(), true))
  }

  private renderSide(): void {
    this.sideBtn.textContent = this.anns.length ? `Annotations (${this.anns.length})` : 'Annotations'
    this.side.replaceChildren(el('h4', undefined, 'Dans ce PDF'))
    if (!this.api?.review || !this.docId) { this.side.appendChild(el('div', 'pdfv-empty', 'La révision n’est pas disponible pour ce PDF.')); return }
    if (!this.anns.length) {
      this.side.appendChild(el('div', 'pdfv-empty', 'Sélectionnez du texte (ou tracez une zone) pour surligner, ancrer ou commenter.'))
      return
    }
    for (const a of this.anns) {
      const t = a.target
      const item = el('div', `pdfv-item${a.status === 'resolved' ? ' resolved' : ''}`)
      item.dataset.testid = 'pdf-ann-item'
      const sw = el('div', 'pdfv-sw')
      sw.style.background = t.mark === 'highlight' ? PDF_COLORS[t.color ?? 'jaune'] : t.mark === 'anchor' ? 'var(--accent, #3b82f6)' : '#f59e0b'
      const body = el('div', 'pdfv-body')
      const kind = t.mark === 'highlight' ? 'Surlignage' : t.mark === 'anchor' ? `Ancre${t.label ? ` « ${t.label} »` : ''}` : 'Commentaire'
      const replies = a.replies.length ? ` · ${a.replies.length} réponse(s)` : ''
      body.append(
        el('div', 'pdfv-meta', `${kind} · p. ${t.page} · ${a.authorName}${a.byAgent ? ' (IA)' : ''}${replies}`),
        el('div', 'pdfv-q', t.quote ? `« ${squashSpaces(t.quote)} »` : t.zone ? 'Zone' : 'Page entière'),
      )
      if (a.text.trim()) body.appendChild(el('div', 'pdfv-c', a.text))
      item.append(sw, body)
      item.addEventListener('click', () => this.goToAnn(a, true))
      this.side.appendChild(item)
    }
  }

  // ── Aller a un endroit ────────────────────────────────────────────────────

  currentPage(): number {
    const top = this.scroller.scrollTop + this.scroller.clientHeight * 0.3
    let cur = 1
    for (const s of this.slots) { if (s.el.offsetTop <= top) cur = s.n; else break }
    return cur
  }

  private onScroll(): void {
    const n = this.currentPage()
    if (document.activeElement !== this.pageInput) this.pageInput.value = String(n)
    this.scheduleReport()
  }

  goToPage(n: number, y = 0): void {
    const s = this.slots[Math.max(1, Math.min(this.slots.length, Math.round(n))) - 1]
    if (!s) return
    this.scroller.scrollTop = s.el.offsetTop - 12 + y * s.el.offsetHeight
    this.pageInput.value = String(s.n)
  }

  private goToAnn(a: Ann, openCard: boolean): void {
    const place = this.placeOf(a) ?? { page: a.target.page, rects: a.target.rects }
    const box = pdfRectsBounds(place.rects)
    this.goToPage(place.page, box ? Math.max(0, box[1] - 0.15) : 0)
    this.focusId = a.id
    const slot = this.slots[place.page - 1]
    const after = () => {
      if (slot?.drawn) this.drawMarks(slot)
      this.flash(a.id)
      if (openCard) this.openCard(a)
      this.report(a)
    }
    // La page vient peut-etre seulement d'entrer a l'ecran : attendre son dessin.
    if (slot && !slot.drawn) {
      this.visible.add(slot.n)
      this.drawVisible()
      void (slot.drawing ?? Promise.resolve()).then(() => requestAnimationFrame(after))
    } else {
      requestAnimationFrame(after)
    }
  }

  /** La suite d'un lien : « page=3 », « ^ref ». */
  reveal(subpath: string): void {
    if (!this.slots.length) { this.pendingReveal = subpath; return }
    const to = parsePdfSubpath(subpath)
    if (!to) return
    if ('page' in to) { this.goToPage(to.page); return }
    const a = this.anns.find(x => x.target.ref === to.ref)
    if (a) this.goToAnn(a, false)
    else this.status.textContent = 'Ce passage n’existe plus dans le PDF (ancre retirée).'
  }

  // ── Selection, zone, menu ─────────────────────────────────────────────────

  private slotOf(node: Node | null): Slot | null {
    const page = (node instanceof Element ? node : node?.parentElement)?.closest?.('.pdfv-page') as HTMLElement | null
    return page ? this.slots[Number(page.dataset.page) - 1] ?? null : null
  }

  private normRect(s: Slot, r: DOMRect | { left: number; top: number; width: number; height: number }): PdfRect {
    const b = s.el.getBoundingClientRect()
    return [(r.left - b.left) / b.width, (r.top - b.top) / b.height, r.width / b.width, r.height / b.height]
  }

  /** Le texte autour d'un passage de la page (pour le retrouver si le fichier change). */
  private around(s: Slot, quote: string): { prefix: string; suffix: string; before: string; after: string } {
    const at = locatePdfQuote([s.content], { quote }, 1)
    if (!at) return { prefix: '', suffix: '', before: '', after: '' }
    const flat = (x: string) => x.replace(/\s+/g, ' ')
    const before = flat(s.content.slice(Math.max(0, at.from - 300), at.from))
    const after = flat(s.content.slice(at.to, at.to + 300))
    return {
      prefix: before.slice(-PDF_SIDE_CHARS), suffix: after.slice(0, PDF_SIDE_CHARS),
      before: before.split(' ').slice(-10).join(' ').trim(), after: after.split(' ').slice(0, 10).join(' ').trim(),
    }
  }

  /** Un clic dans un menu (ou sur un bouton qu'il vient de retirer) ne touche pas aux pages. */
  private inPop(e: Event): boolean {
    const t = e.target as Element
    return !t.isConnected || !!t.closest('.pdfv-pop')
  }

  private onMouseDown(e: MouseEvent): void {
    if (e.button !== 0 || this.inPop(e)) return
    if (!(this.zoning || e.altKey)) return
    const s = this.slotOf(e.target as Node)
    if (!s) return
    e.preventDefault()
    window.getSelection()?.removeAllRanges()
    this.closePop()
    const b = s.el.getBoundingClientRect()
    const x0 = e.clientX - b.left, y0 = e.clientY - b.top
    const draft = el('div', 'pdfv-zone-draft')
    s.el.appendChild(draft)
    const move = (ev: MouseEvent) => {
      const x1 = Math.max(0, Math.min(b.width, ev.clientX - b.left)), y1 = Math.max(0, Math.min(b.height, ev.clientY - b.top))
      Object.assign(draft.style, { left: `${Math.min(x0, x1)}px`, top: `${Math.min(y0, y1)}px`, width: `${Math.abs(x1 - x0)}px`, height: `${Math.abs(y1 - y0)}px` })
    }
    const up = (ev: MouseEvent) => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up, true)
      draft.remove()
      this.swallowClick = true
      setTimeout(() => { this.swallowClick = false }, 0)
      const x1 = Math.max(0, Math.min(b.width, ev.clientX - b.left)), y1 = Math.max(0, Math.min(b.height, ev.clientY - b.top))
      if (Math.abs(x1 - x0) < 6 || Math.abs(y1 - y0) < 6) return
      const rect: PdfRect = [Math.min(x0, x1) / b.width, Math.min(y0, y1) / b.height, Math.abs(x1 - x0) / b.width, Math.abs(y1 - y0) / b.height]
      const quote = this.textInZone(s, rect)
      const target = this.newTarget(s, normalizePdfRects([rect]), quote, true)
      this.report(null, target)
      this.openMenu(target, ev.clientX, ev.clientY)
      if (this.zoning) this.setZoning(false)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up, true)
  }

  private setZoning(on: boolean): void {
    this.zoning = on
    this.zoneBtn.classList.toggle('on', on)
    this.scroller.classList.toggle('zoning', on)
  }

  /** Le texte dans une zone : les morceaux de la couche de texte dont le milieu y tombe. */
  private textInZone(s: Slot, zone: PdfRect): string {
    const b = s.el.getBoundingClientRect()
    const parts: string[] = []
    for (const span of Array.from(s.text.querySelectorAll('span'))) {
      if (span.children.length) continue
      const r = span.getBoundingClientRect()
      const cx = (r.left + r.width / 2 - b.left) / b.width, cy = (r.top + r.height / 2 - b.top) / b.height
      if (cx >= zone[0] && cx <= zone[0] + zone[2] && cy >= zone[1] && cy <= zone[1] + zone[3]) parts.push(span.textContent ?? '')
    }
    return squashSpaces(parts.join(' ')).slice(0, MAX_PDF_QUOTE)
  }

  private onMouseUp(e: MouseEvent): void {
    if (this.inPop(e) || this.zoning || e.altKey) return
    // La selection est posee juste apres le relachement.
    setTimeout(() => {
      if (this.dead) return
      const sel = window.getSelection()
      if (!sel || sel.isCollapsed || !sel.rangeCount) return
      const range = sel.getRangeAt(0)
      const s = this.slotOf(range.startContainer)
      if (!s || !this.root.contains(range.commonAncestorContainer)) return
      const quote = squashSpaces(sel.toString()).slice(0, MAX_PDF_QUOTE)
      if (!quote) return
      const b = s.el.getBoundingClientRect()
      const rects = Array.from(range.getClientRects())
        .filter(r => r.width > 0.5 && r.height > 0.5 && r.bottom > b.top && r.top < b.bottom)
        .map(r => this.normRect(s, r))
      const target = this.newTarget(s, normalizePdfRects(rects), quote, false)
      this.report(null, target)
      const last = range.getClientRects()
      const end = last[last.length - 1]
      this.openMenu(target, end ? end.right : e.clientX, end ? end.bottom : e.clientY)
    }, 0)
  }

  private onClick(e: MouseEvent): void {
    if (this.inPop(e) || this.swallowClick) return
    const sel = window.getSelection()
    if (sel && !sel.isCollapsed) return
    const s = this.slotOf(e.target as Node)
    if (!s) { this.closePop(); return }
    const b = s.el.getBoundingClientRect()
    const x = (e.clientX - b.left) / b.width, y = (e.clientY - b.top) / b.height
    const pad = 0.004
    const hit = this.anns.filter(a => {
      const place = this.placeOf(a)
      if (!place || place.page !== s.n) return false
      const rects = place.rects.length ? place.rects : [[0, 0, 1, 1] as PdfRect]
      return rects.some(r => x >= r[0] - pad && x <= r[0] + r[2] + pad && y >= r[1] - pad && y <= r[1] + r[3] + pad)
    })
    // Le plus petit d'abord : une marque dans une autre se choisit d'un clic.
    hit.sort((p, q) => area(p.target.rects) - area(q.target.rects))
    const a = hit[0]
    if (!a) { this.closePop(); this.focusId = null; this.redrawFocus(); this.scheduleReport(); return }
    this.focusId = a.id
    this.redrawFocus()
    this.openCard(a, e.clientX, e.clientY)
    this.report(a)
  }

  private redrawFocus(): void {
    for (const m of Array.from(this.root.querySelectorAll<HTMLElement>('.pdfv-mark'))) m.classList.toggle('focus', m.dataset.id === this.focusId)
  }

  private newTarget(s: Slot, rects: PdfRect[], quote: string, zone: boolean): PdfTarget {
    const { prefix, suffix } = quote ? this.around(s, quote) : { prefix: '', suffix: '' }
    return {
      kind: 'pdf', page: s.n, rects, quote, ref: newPdfRef(),
      ...(prefix ? { prefix } : {}), ...(suffix ? { suffix } : {}), ...(zone ? { zone: true } : {}), ...(this.fp ? { fp: this.fp } : {}),
    }
  }

  private placePop(pop: HTMLDivElement, clientX: number, clientY: number): void {
    const b = this.scroller.getBoundingClientRect()
    const x = clientX - b.left + this.scroller.scrollLeft
    const y = clientY - b.top + this.scroller.scrollTop + 8
    pop.style.left = `${Math.max(4, Math.min(x - 20, this.scroller.scrollWidth - (pop.offsetWidth || 320) - 8))}px`
    pop.style.top = `${y}px`
  }

  private closePop(): void {
    this.popCleanup?.()
    this.popCleanup = null
    this.pop?.remove()
    this.pop = null
  }

  /** Le menu d'une selection ou d'une zone : surligner (couleurs), ancrer, commenter, lien. */
  private openMenu(target: PdfTarget, clientX: number, clientY: number): void {
    this.closePop()
    const pop = el('div', 'pdfv-pop')
    pop.dataset.testid = 'pdf-menu'
    const write = this.canWrite()
    if (write) {
      for (const [name, color] of Object.entries(PDF_COLORS) as [PdfColor, string][]) {
        const dot = el('button', 'pdfv-dot')
        dot.type = 'button'
        dot.title = `Surligner en ${name}`
        dot.dataset.testid = `pdf-hl-${name}`
        dot.style.background = color
        dot.addEventListener('click', () => { void this.addMark({ ...target, mark: 'highlight', color: name }) })
        pop.appendChild(dot)
      }
      pop.append(
        this.popBtn('Ancre', 'Nommer ce passage pour le citer ailleurs', () => this.askAnchorName(target), 'pdf-anchor'),
        this.popBtn('Commenter', 'Ouvrir un fil de la Révision sur ce passage', () => this.draftComment(target), 'pdf-comment'),
        this.popBtn('Lien', 'Copier un lien vers ce passage (crée une ancre)', () => { void this.addMark({ ...target, mark: 'anchor', label: defaultLabel(target) }, true) }, 'pdf-link'),
      )
    } else {
      pop.appendChild(el('span', 'pdfv-empty', 'Lecture seule : pas de surlignage ici.'))
    }
    this.scroller.appendChild(pop)
    this.pop = pop
    this.placePop(pop, clientX, clientY)
  }

  private popBtn(label: string, title: string, run: () => void, testid: string): HTMLButtonElement {
    const b = el('button', 'pdfv-btn', label)
    b.type = 'button'
    b.title = title
    b.dataset.testid = testid
    b.addEventListener('click', run)
    return b
  }

  private askAnchorName(target: PdfTarget): void {
    const pop = this.pop
    if (!pop) return
    pop.replaceChildren()
    const input = el('input')
    input.placeholder = 'Nom de l’ancre'
    input.value = defaultLabel(target)
    input.dataset.testid = 'pdf-anchor-name'
    const ok = this.popBtn('Ancrer', 'Créer l’ancre et copier son lien', () => { void this.addMark({ ...target, mark: 'anchor', label: input.value.trim() || defaultLabel(target) }, true) }, 'pdf-anchor-ok')
    input.addEventListener('keydown', e => { if (e.key === 'Enter') ok.click(); if (e.key === 'Escape') this.closePop() })
    pop.append(input, ok)
    input.focus()
    input.select()
  }

  private async addMark(target: PdfTarget, copy = false): Promise<void> {
    const review = this.api?.review
    if (!review || !this.docId) return
    try {
      const id = await review.comment(this.docId, '', target, { mark: true })
      window.getSelection()?.removeAllRanges()
      this.closePop()
      this.focusId = id
      this.refreshAnns()
      if (copy) await this.copyLink({ ref: target.ref }, target.label)
    } catch (err) {
      this.status.textContent = `Impossible : ${err instanceof Error ? err.message : String(err)}`
    }
  }

  private draftComment(target: PdfTarget): void {
    const review = this.api?.review
    const pop = this.pop
    if (!review?.renderDraft || !this.docId || !pop) return
    pop.className = 'pdfv-pop card'
    pop.replaceChildren()
    const box = el('div')
    pop.appendChild(box)
    this.popCleanup = review.renderDraft(box, { docId: this.docId, kind: 'comment', quote: describePdfTarget(target), target }, {
      onDone: () => { window.getSelection()?.removeAllRanges(); this.closePop(); this.refreshAnns() },
    })
  }

  /** La carte d'une marque : ce qu'elle vise, son lien, la retirer ; puis le fil de la Revision. */
  private openCard(a: Ann, clientX?: number, clientY?: number): void {
    this.closePop()
    const review = this.api?.review
    const pop = el('div', 'pdfv-pop card')
    pop.dataset.testid = 'pdf-card'
    const head = el('div', 'pdfv-card-head')
    const t = a.target
    const kind = t.mark === 'highlight' ? 'Surlignage' : t.mark === 'anchor' ? 'Ancre' : 'Commentaire'
    head.append(el('span', 'pdfv-what', `${kind} · ${describePdfTarget(t, 50)}`))
    head.appendChild(this.popBtn('Lien', 'Copier le lien vers ce passage', () => { void this.copyLink({ ref: t.ref }, t.label) }, 'pdf-card-link'))
    if (t.mark && this.canWrite() && review?.removeMark) {
      head.appendChild(this.popBtn('Retirer', 'Retirer cette marque (la Révision en garde la trace)', () => {
        void review.removeMark!(a.id).then(() => { this.closePop(); this.refreshAnns() }, err => { this.status.textContent = String(err instanceof Error ? err.message : err) })
      }, 'pdf-card-remove'))
    }
    pop.appendChild(head)
    if (review?.renderAnnotation) {
      const box = el('div')
      pop.appendChild(box)
      this.popCleanup = review.renderAnnotation([a.id], box, { onDone: () => { this.closePop(); this.refreshAnns() } })
    }
    this.scroller.appendChild(pop)
    this.pop = pop
    if (clientX !== undefined && clientY !== undefined) this.placePop(pop, clientX, clientY)
    else {
      const mark = this.root.querySelector<HTMLElement>(`.pdfv-mark[data-id="${CSS.escape(a.id)}"]`)
      const r = mark?.getBoundingClientRect()
      if (r) this.placePop(pop, r.left, r.bottom)
    }
  }

  private async copyLink(to: { page: number } | { ref: string }, label?: string): Promise<void> {
    const name = this.api?.vault?.linkTarget?.(this.path) ?? this.ctx.vault?.linkTarget?.(this.path) ?? this.path
    const link = pdfWikiLink(name, to, label)
    try {
      await navigator.clipboard.writeText(link)
      this.api?.workspace?.notify?.('success', 'Lien copié', link)
      this.status.textContent = `Lien copié : ${link}`
    } catch {
      this.status.textContent = `Lien : ${link}`
    }
  }

  // ── Retrouver un texte dans la couche de texte (autre version du fichier) ─

  private rectsForQuote(s: Slot, quote: string): PdfRect[] {
    const nodes: { node: Text; start: number }[] = []
    let flat = ''
    const walker = document.createTreeWalker(s.text, NodeFilter.SHOW_TEXT)
    for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) {
      nodes.push({ node: n, start: flat.length })
      flat += n.data
    }
    const at = locatePdfQuote([flat], { quote }, 1)
    if (!at) return []
    const pos = (i: number): [Text, number] | null => {
      for (let k = nodes.length - 1; k >= 0; k--) if (nodes[k]!.start <= i) return [nodes[k]!.node, Math.min(nodes[k]!.node.length, i - nodes[k]!.start)]
      return null
    }
    const a = pos(at.from), b = pos(at.to)
    if (!a || !b) return []
    const range = document.createRange()
    range.setStart(a[0], a[1])
    range.setEnd(b[0], b[1])
    return normalizePdfRects(Array.from(range.getClientRects()).map(r => this.normRect(s, r)))
  }

  // ── Contexte de l'IA ──────────────────────────────────────────────────────

  private scheduleReport(): void {
    if (this.reportTimer) clearTimeout(this.reportTimer)
    this.reportTimer = setTimeout(() => {
      this.reportTimer = null
      const sel = window.getSelection()
      if (sel && !sel.isCollapsed && this.root.contains(sel.anchorNode)) return
      if (!this.focusId) this.report(null)
    }, 800)
  }

  /** Dit a l'IA ce que la personne regarde : une marque, une selection, ou seulement la page. */
  private report(a: Ann | null, target?: PdfTarget): void {
    const ws = this.api?.workspace
    if (!ws?.reportContext || !this.docId || !this.slots.length) return
    const t = a?.target ?? target
    const page = t?.page ?? this.currentPage()
    const slot = this.slots[page - 1]
    const quote = t?.quote ?? ''
    const ctx = quote && slot ? this.around(slot, quote) : { before: '', after: '' }
    ws.reportContext({
      vaultId: this.ctx.vaultId,
      docId: this.docId, path: this.path, selection: quote, before: ctx.before, after: ctx.after,
      pdf: {
        page, pages: this.slots.length, rects: t?.rects ?? [],
        ...(a ? { ref: a.target.ref, ...(a.target.mark ? { mark: a.target.mark } : {}), ...(a.target.color ? { color: a.target.color } : {}), ...(a.target.label ? { label: a.target.label } : {}), ...(a.text.trim() ? { comment: a.text.trim() } : {}) } : {}),
        ...(slot?.scanned ? { ocr: true } : {}),
      },
    })
  }
}

function area(rects: readonly PdfRect[]): number {
  if (!rects.length) return 1
  return rects.reduce((sum, r) => sum + r[2] * r[3], 0)
}

/** Nom propose pour une ancre : les premiers mots du passage, sinon « Zone p. 3 ». */
function defaultLabel(t: PdfTarget): string {
  const words = squashSpaces(t.quote).split(' ').filter(Boolean)
  if (!words.length) return t.zone ? `Zone p. ${t.page}` : `Page ${t.page}`
  const s = words.slice(0, 6).join(' ')
  return words.length > 6 ? `${s}…` : s
}
