// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Export d'une presentation : PDF (une page par diapositive, par la boite
// d'impression, comme l'export PDF d'une note) et PowerPoint (.pptx).
import { slideDeck, type SlideDeck } from '@savoire/plugin-api'
import { settle } from './PdfExport'
import { SLIDE_SIZE, ensureSlidesStyle, fitSlide, releaseSlide, renderSlide, slideColors, slideSettings, toHex, type SlideRenderOptions } from './Slides'
import { buildPptx, pictureOf, readSlideBody, type PptxSlide } from './SlidesPptx'

export interface SlidesExportOptions extends SlideRenderOptions {
  /** Nom de la presentation (titre du PDF, nom du fichier). */
  title?: string
}

/** Rend toutes les diapositives hors de la vue, a leur taille, ajustees. */
async function renderAll(deck: SlideDeck, opts: SlideRenderOptions): Promise<{ host: HTMLElement; slides: HTMLElement[] }> {
  ensureSlidesStyle()
  const { w } = SLIDE_SIZE[deck.ratio]
  const host = document.createElement('div')
  host.setAttribute('aria-hidden', 'true')
  host.style.cssText = `position:fixed;left:-${w * 2 + 1000}px;top:0;width:${w}px;visibility:hidden;pointer-events:none`
  document.body.appendChild(host)
  const slides = deck.slides.map(s => {
    const el = renderSlide(deck, s, opts)
    host.appendChild(el)
    return el
  })
  await settle(document, 4000)
  for (const el of slides) fitSlide(el)
  return { host, slides }
}

function printPlaceholder(label: string): HTMLElement {
  const box = document.createElement('div')
  box.style.cssText = 'display:flex;align-items:center;justify-content:center;min-height:120px;margin:0 0 .5em;border:2px dashed var(--slide-border);border-radius:8px;color:var(--slide-muted);font-size:.7em'
  box.textContent = `▶ ${label}`
  return box
}

const safeName = (title: string) => (title.trim() || 'Présentation').replace(/[\\/:*?"<>|]+/g, '-')

/** Imprime la presentation : une page par diapositive (« Enregistrer au format PDF »). */
export async function printSlides(text: string, opts: SlidesExportOptions = {}): Promise<void> {
  const deck = slideDeck(text)
  if (!deck.slides.length) return
  const { w, h } = SLIDE_SIZE[deck.ratio]
  const { host, slides } = await renderAll(deck, opts)
  const frame = document.createElement('iframe')
  frame.setAttribute('aria-hidden', 'true')
  frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden'
  document.body.appendChild(frame)
  try {
    const doc = frame.contentDocument!
    doc.open()
    doc.write('<!doctype html><html><head><meta charset="utf-8"></head><body></body></html>')
    doc.close()
    doc.title = safeName(opts.title ?? '')
    for (const s of Array.from(document.querySelectorAll('style, link[rel="stylesheet"]'))) doc.head.appendChild(doc.importNode(s, true))
    const style = doc.createElement('style')
    style.textContent = `
      @page { size: ${w}px ${h}px; margin: 0; }
      html, body { margin: 0; padding: 0; background: #fff; }
      * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
      .plume-slide { break-after: page; page-break-after: always; }
      .plume-slide:last-child { break-after: auto; page-break-after: auto; }
      .plume-slide button { display: none !important; }`
    doc.head.appendChild(style)
    for (const el of slides) {
      // Un cadre (animation, board) ne survit pas au passage dans la page
      // d'impression : son nom a sa place.
      releaseSlide(el)
      for (const embed of Array.from(el.querySelectorAll<HTMLElement>('[data-export-label], iframe'))) {
        if (!embed.isConnected || (embed.tagName === 'IFRAME' && embed.closest('[data-export-label]'))) continue
        embed.replaceWith(printPlaceholder(embed.dataset.exportLabel ?? embed.getAttribute('title') ?? 'Contenu intégré'))
      }
      doc.body.appendChild(doc.adoptNode(el))
    }
    await settle(doc, 2000)
    const previous = document.title
    document.title = doc.title
    try {
      frame.contentWindow!.focus()
      frame.contentWindow!.print()
    } finally {
      document.title = previous
    }
  } finally {
    host.remove()
    setTimeout(() => { releaseSlide(frame.contentDocument?.body); frame.remove() }, 1000)
  }
}

/** Le fichier .pptx de la presentation. */
export async function slidesToPptx(text: string, opts: SlidesExportOptions = {}): Promise<Blob> {
  const deck = slideDeck(text)
  const { host, slides } = await renderAll(deck, opts)
  try {
    const out: PptxSlide[] = []
    for (let i = 0; i < slides.length; i++) {
      const body = slides[i]!.querySelector<HTMLElement>('.plume-slide-body')!
      const read = readSlideBody(body)
      const pictures = (await Promise.all(read.images.slice(0, 6).map(pictureOf))).filter(p => p !== null)
      const slide = deck.slides[i]!
      const set = slideSettings(deck, slide)
      const bgImg = slides[i]!.querySelector<HTMLImageElement>('.plume-slide-image img')
      const bgPicture = bgImg ? await pictureOf(bgImg) : null
      out.push({
        title: read.title, paragraphs: read.paragraphs, pictures, notes: slide.notes, cover: slide.cover,
        transition: set.transition,
        decor: set.decor,
        background: slide.options.background ? toHex(slide.options.background) ?? undefined : undefined,
        image: bgPicture && slide.image ? { picture: bgPicture, side: slide.image.side } : undefined,
      })
    }
    return buildPptx({ title: opts.title ?? '', ratio: deck.ratio, colors: slideColors(deck.theme), slides: out })
  } finally {
    releaseSlide(host)
    host.remove()
  }
}

/** Enregistre la presentation en .pptx (telechargement). */
export async function downloadSlidesPptx(text: string, opts: SlidesExportOptions = {}): Promise<void> {
  const blob = await slidesToPptx(text, opts)
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${safeName(opts.title ?? '')}.pptx`
  a.style.display = 'none'
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 30_000)
}
