// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// OCR d'une page de PDF scannee : la page est dessinee (pdf.js), son image
// lue par Tesseract (le moteur du plugin Images, francais et anglais), mot a
// mot. Les mots gardent leur place sur la page (fractions de la page) : la vue
// les pose sous l'image comme un texte, qu'on selectionne, surligne et ancre
// comme celui d'un PDF ordinaire.
//
// Le meme code tourne dans l'appli (canvas du navigateur) et sur le pair
// indexeur (Node : canvas de @napi-rs/canvas, que pdf.js charge lui-meme).
import { pdfOcrText, type PdfOcrPage, type PdfOcrWord } from '@savoire/plugin-api'
import { OCR_LANGUAGES, ocrEnabled, tesseractWords, type OcrWords } from '@savoire/plugin-images'
import type { PdfDocument, PdfPage } from './pdfjs'

/** Resolution visee pour l'OCR (points par pouce) ; et le plus grand cote de l'image, au plus. */
const OCR_DPI = 300
const OCR_MAX_SIDE = 2800
/** Moins de caracteres que cela sur une page : elle est tenue pour scannee. */
export const MIN_PAGE_TEXT = 8

export { ocrEnabled }

interface CanvasAndContext { canvas: { width: number; height: number; toBlob?(cb: (b: Blob | null) => void, type?: string): void; toBuffer?(type: string): Uint8Array }; context: unknown }
interface CanvasFactory { create(width: number, height: number): CanvasAndContext; destroy(c: CanvasAndContext): void }

/** La page dessinee en PNG, a la resolution de l'OCR. */
export async function renderPagePng(doc: PdfDocument, page: PdfPage): Promise<Uint8Array> {
  const base = page.getViewport({ scale: 1 })
  const scale = Math.min(OCR_DPI / 72, OCR_MAX_SIDE / Math.max(base.width, base.height))
  const viewport = page.getViewport({ scale })
  const factory = (doc as unknown as { canvasFactory: CanvasFactory }).canvasFactory
  const cc = factory.create(Math.ceil(viewport.width), Math.ceil(viewport.height))
  try {
    await page.render({ canvas: cc.canvas as unknown as HTMLCanvasElement, viewport }).promise
    if (typeof cc.canvas.toBuffer === 'function') return new Uint8Array(cc.canvas.toBuffer('image/png'))
    const blob = await new Promise<Blob | null>(resolve => cc.canvas.toBlob!(resolve, 'image/png'))
    if (!blob) throw new Error('page non dessinée')
    return new Uint8Array(await blob.arrayBuffer())
  } finally {
    factory.destroy(cc)
  }
}

/** Les mots reconnus (en pixels de l'image) ramenes a la page (fractions). */
export function toOcrPage(lines: { text: string; x0: number; y0: number; x1: number; y1: number; confidence: number }[][], width: number, height: number, page: number, fp?: string, at = new Date()): PdfOcrPage {
  const words: PdfOcrWord[] = []
  const starts: number[] = []
  const r4 = (x: number) => Math.round(x * 10000) / 10000
  for (const line of lines) {
    if (!line.length) continue
    starts.push(words.length)
    for (const w of line) {
      words.push({ t: w.text, b: [r4(w.x0 / width), r4(w.y0 / height), r4((w.x1 - w.x0) / width), r4((w.y1 - w.y0) / height)], c: w.confidence })
    }
  }
  return { v: 1, page, words, lines: starts, langs: [...OCR_LANGUAGES], at: at.toISOString(), ...(fp ? { fp } : {}) }
}

/** Largeur et hauteur d'une image PNG (en-tete IHDR). */
function pngSize(png: Uint8Array): { width: number; height: number } {
  const v = new DataView(png.buffer, png.byteOffset, png.byteLength)
  return { width: v.getUint32(16), height: v.getUint32(20) }
}

/**
 * Reconnait le texte d'une page. `words` : le moteur (Tesseract par defaut ;
 * un autre dans les tests). Rejette si l'OCR est coupe ou echoue.
 */
export async function ocrPdfPage(doc: PdfDocument, n: number, words: OcrWords = tesseractWords): Promise<PdfOcrPage> {
  const page = await doc.getPage(n)
  try {
    const png = await renderPagePng(doc, page)
    const { width, height } = pngSize(png)
    const lines = await words(png)
    return toOcrPage(lines, width, height, n, doc.fingerprints[0] ?? undefined)
  } finally {
    page.cleanup()
  }
}

export { pdfOcrText }
