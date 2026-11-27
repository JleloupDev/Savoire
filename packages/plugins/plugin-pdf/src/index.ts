// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// plugin-pdf — lire les PDF : leur texte dans la recherche (une section par
// page), leurs metadonnees, et leur lecture dans Savoire (view.ts) : surligner,
// ancrer un passage ou une zone pour le citer ailleurs, commenter. Surlignages
// et ancres sont des fils de la Revision (cible PdfTarget, plugin-api/pdf.ts).
//
// Pages scannees (une image, pas de texte) : l'OCR (ocr.ts) en reconnait le
// texte. Il est garde dans le vault (annexe « ocr » du PDF), pour tous :
//  - le pair indexeur s'en sert pour la recherche ; sans lui, il fait l'OCR
//    lui-meme a l'indexation (ce qu'il reconnait reste dans son index) ;
//  - la vue le fait pour les pages ouvertes qui n'en ont pas encore, et
//    l'ecrit dans l'annexe (une fois pour tout le monde).
import {
  PDF_OCR_ANNEX, parsePdfOcrPage, pdfOcrKey, pdfOcrText,
  MAX_READ_PAGES,
  type ByteRangeSource, type ExtractedContent, type ExtractedPages, type ExtractInfo, type ExtractorSpec, type FileContext, type PdfOcrPage, type PluginAPI, type PropertyValue, type VaultPlugin,
} from '@savoire/plugin-api'
import type { OcrWords } from '@savoire/plugin-images'
import { MIN_PAGE_TEXT, ocrEnabled, ocrPdfPage } from './ocr'
import { openPdf, openPdfRange, pageText } from './pdfjs'
import { createPdfView } from './view'

export { configurePdf } from './pdfjs'
export { toOcrPage } from './ocr'

/** Pages lues au plus (un PDF de 2 000 pages n'a pas besoin de tout dans l'index). */
export const MAX_PAGES = 500
/** Pages scannees reconnues au plus par l'indexation (quelques secondes chacune). */
export const MAX_OCR_PAGES = 60

/** « D:20260115093000+01'00' » -> « 2026-01-15 ». */
function pdfDate(v: unknown): string | undefined {
  const m = typeof v === 'string' ? /^D:(\d{4})(\d{2})(\d{2})/.exec(v) : null
  return m ? `${m[1]}-${m[2]}-${m[3]}` : undefined
}

export interface ExtractPdfOptions {
  /** Pages deja reconnues (annexe « ocr »), par numero. */
  known?: ReadonlyMap<number, PdfOcrPage>
  /** Moteur d'OCR des pages scannees qui manquent ; null : pas d'OCR. Defaut : Tesseract, s'il est permis ici. */
  ocr?: OcrWords | null
}

/** Les pages reconnues d'une annexe « ocr » (racine : p1, p2... en JSON), pour ce fichier. */
export function knownOcrPages(root: Record<string, unknown> | null | undefined, fingerprint?: string): Map<number, PdfOcrPage> {
  const out = new Map<number, PdfOcrPage>()
  for (const [key, raw] of Object.entries(root ?? {})) {
    if (!/^p\d+$/.test(key)) continue
    const page = parsePdfOcrPage(raw)
    // Une autre version du fichier : ces mots ne sont plus les siens.
    if (page && key === pdfOcrKey(page.page) && (!fingerprint || !page.fp || page.fp === fingerprint)) out.set(page.page, page)
  }
  return out
}

export async function extractPdf(bytes: Uint8Array, opts: ExtractPdfOptions = {}): Promise<ExtractedContent> {
  const { doc, destroy } = await openPdf(bytes)
  try {
    const sections = []
    const pages = Math.min(doc.numPages, MAX_PAGES)
    const engine = opts.ocr === undefined ? (ocrEnabled() ? undefined : null) : opts.ocr
    const fp = doc.fingerprints[0] ?? undefined
    let recognized = 0
    let ocrDone = 0
    for (let n = 1; n <= pages; n++) {
      const page = await doc.getPage(n)
      let text = await pageText(page)
      page.cleanup()
      if (text.length < MIN_PAGE_TEXT) {
        // Page scannee : le texte reconnu, deja garde ou a reconnaitre.
        const kept = opts.known?.get(n)
        const known = kept && (!kept.fp || !fp || kept.fp === fp) ? kept : undefined
        let ocr = known ? pdfOcrText(known) : ''
        if (!known && engine !== null && ocrDone < MAX_OCR_PAGES) {
          ocrDone++
          ocr = await ocrPdfPage(doc, n, engine).then(pdfOcrText, err => { console.warn('[plugin-pdf] OCR impossible', n, err); return '' })
        }
        if (ocr.trim()) { text = ocr.trim(); recognized++ }
      }
      if (text) sections.push({ heading: `Page ${n}`, text })
    }
    const meta = await doc.getMetadata().catch(() => null)
    const info = (meta?.info ?? {}) as Record<string, unknown>
    const props: Record<string, PropertyValue> = { pages: doc.numPages }
    if (recognized) props.pages_reconnues = recognized
    if (typeof info.Author === 'string' && info.Author.trim()) props.auteur = info.Author.trim()
    const created = pdfDate(info.CreationDate)
    if (created) props.cree_le = created
    const title = typeof info.Title === 'string' && info.Title.trim() ? info.Title.trim() : undefined
    return { ...(title ? { title } : {}), sections, props }
  } finally {
    await destroy()
  }
}

/**
 * Quelques pages d'un PDF, lues par morceaux (ExtractorSpec.readPages) : le
 * MCP lit ainsi « les pages 120 a 135 » d'un gros PDF, sans le telecharger ni
 * l'extraire en entier. Une page scannee rend le texte deja reconnu (annexe
 * « ocr ») s'il existe ; pas d'OCR ici (trop long pour une lecture).
 */
export async function readPdfPages(source: ByteRangeSource, from: number, to: number, opts: { known?: ReadonlyMap<number, PdfOcrPage> } = {}): Promise<ExtractedPages> {
  const { doc, destroy } = await openPdfRange(source)
  try {
    const total = doc.numPages
    const a = Math.max(1, Math.min(Math.floor(from) || 1, total))
    const b = Math.max(a, Math.min(Math.floor(to) || a, total, a + MAX_READ_PAGES - 1))
    const fp = doc.fingerprints[0] ?? undefined
    const pages: { page: number; text: string }[] = []
    for (let n = a; n <= b; n++) {
      const page = await doc.getPage(n)
      let text = await pageText(page)
      page.cleanup()
      if (text.length < MIN_PAGE_TEXT) {
        const kept = opts.known?.get(n)
        if (kept && (!kept.fp || !fp || kept.fp === fp)) text = pdfOcrText(kept).trim() || text
      }
      pages.push({ page: n, text })
    }
    const meta = await doc.getMetadata().catch(() => null)
    const info = (meta?.info ?? {}) as Record<string, unknown>
    const title = typeof info.Title === 'string' && info.Title.trim() ? info.Title.trim() : undefined
    return { total, from: a, to: b, pages, ...(title ? { title } : {}) }
  } finally {
    await destroy()
  }
}

/** L'extraction de l'index : avec le texte reconnu deja garde dans le vault, s'il est lisible ici. */
async function extractForIndex(bytes: Uint8Array, info: ExtractInfo): Promise<ExtractedContent> {
  const root = await info.annex?.(PDF_OCR_ANNEX).catch(() => null)
  // L'empreinte du fichier n'est connue qu'a son ouverture : extractPdf la verifie page par page.
  return extractPdf(bytes, { known: knownOcrPages(root) })
}

export const EXTRACTOR: ExtractorSpec = {
  official: true,
  // 3 : texte des pages scannees (OCR).
  id: 'pdf', label: 'PDF', extensions: ['pdf'], version: 3,
  annexes: [PDF_OCR_ANNEX],
  extract: (b, info) => extractForIndex(b, info),
  readPages: async (source, from, to, info) => {
    const root = await info.annex?.(PDF_OCR_ANNEX).catch(() => null)
    return readPdfPages(source, from, to, { known: knownOcrPages(root) })
  },
}

const FILE_TYPES = [{ extension: 'pdf', label: 'PDF', icon: 'file-text', superType: 'binary' as const }]

let unregister: (() => void) | null = null
let pluginApi: PluginAPI | undefined

const plugin: VaultPlugin = {
  manifest: {
    id: 'plugin-pdf',
    trust: 'verified',
    name: 'PDF',
    version: '0.0.1',
    description: 'Lire les PDF dans Savoire : surligner, ancrer, commenter ; leur texte dans la recherche, OCR des pages scannées',
    scope: 'vault',
    permissions: ['ui:editor', 'vault:read'],
    defaultActive: true,
    // Verifie par l'equipe Savoire : peut tourner sur le pair indexeur du serveur.
    official: true,
  },
  async onload(api: PluginAPI) {
    pluginApi = api
    unregister = api.extractors?.register(EXTRACTOR) ?? null
    for (const t of FILE_TYPES) {
      api.files.register({
        ...t,
        // Le fichier n'est jamais reecrit : surlignages et ancres vivent dans la Revision.
        collaborationMode: 'none',
        creatable: false,
        create: async () => '',
        open: (path: string, ctx: FileContext) => createPdfView(path, ctx, pluginApi),
      })
    }
  },
  async onunload() {
    unregister?.()
    unregister = null
    pluginApi?.files.unregister('pdf')
    pluginApi = undefined
  },
}

export default plugin
