// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// plugin-pdf — lire les PDF : leur texte dans la recherche (une section par
// page), leurs metadonnees, et leur apercu par le lecteur du navigateur.
//
// Le texte est lu par pdf.js (Mozilla, Apache-2.0), dans ce plugin, charge a
// la premiere lecture. Sans worker : le meme code tourne dans le navigateur,
// l'appli de bureau et le pair indexeur (Node). Un PDF scanne n'a pas de
// texte : il en faudrait l'OCR (plugin Images, pour les images).
/// <reference path="./worker.d.ts" />
import { createDocumentPreviewView, nativePreview, type ExtractedContent, type ExtractorSpec, type FileContext, type PluginAPI, type PropertyValue, type VaultPlugin } from '@savoire/plugin-api'

/** Pages lues au plus (un PDF de 2 000 pages n'a pas besoin de tout dans l'index). */
export const MAX_PAGES = 500

type PdfJs = typeof import('pdfjs-dist/legacy/build/pdf.mjs')
let pdfjs: Promise<PdfJs> | null = null

/** pdf.js et son « worker » charges dans le meme fil (pas de fichier de worker a servir). */
function loadPdfJs(): Promise<PdfJs> {
  pdfjs ??= (async () => {
    const lib = await import('pdfjs-dist/legacy/build/pdf.mjs')
    // Le module du worker s'inscrit dans globalThis.pdfjsWorker : pdf.js s'en sert sans worker.
    await import('pdfjs-dist/legacy/build/pdf.worker.mjs')
    return lib
  })().catch(err => { pdfjs = null; throw err })
  return pdfjs
}

/** « D:20260115093000+01'00' » -> « 2026-01-15 ». */
function pdfDate(v: unknown): string | undefined {
  const m = typeof v === 'string' ? /^D:(\d{4})(\d{2})(\d{2})/.exec(v) : null
  return m ? `${m[1]}-${m[2]}-${m[3]}` : undefined
}

export async function extractPdf(bytes: Uint8Array): Promise<ExtractedContent> {
  const lib = await loadPdfJs()
  const task = lib.getDocument({ data: bytes.slice(), disableFontFace: true, useSystemFonts: false, verbosity: 0 })
  const doc = await task.promise
  try {
    const sections = []
    const pages = Math.min(doc.numPages, MAX_PAGES)
    for (let n = 1; n <= pages; n++) {
      const page = await doc.getPage(n)
      const content = await page.getTextContent()
      let text = ''
      for (const item of content.items as { str?: string; hasEOL?: boolean }[]) {
        if (typeof item.str !== 'string') continue
        text += item.str + (item.hasEOL ? '\n' : '')
      }
      page.cleanup()
      text = text.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
      if (text) sections.push({ heading: `Page ${n}`, text })
    }
    const meta = await doc.getMetadata().catch(() => null)
    const info = (meta?.info ?? {}) as Record<string, unknown>
    const props: Record<string, PropertyValue> = { pages: doc.numPages }
    if (typeof info.Author === 'string' && info.Author.trim()) props.auteur = info.Author.trim()
    const created = pdfDate(info.CreationDate)
    if (created) props.cree_le = created
    const title = typeof info.Title === 'string' && info.Title.trim() ? info.Title.trim() : undefined
    return { ...(title ? { title } : {}), sections, props }
  } finally {
    await task.destroy()
  }
}

export const EXTRACTOR: ExtractorSpec = {
  id: 'pdf', label: 'PDF', extensions: ['pdf'], version: 2,
  extract: b => extractPdf(b),
  preview: b => nativePreview(b, 'pdf'),
}

const FILE_TYPES = [{ extension: 'pdf', label: 'PDF', icon: 'file-text', superType: 'binary' as const }]

let unregister: (() => void) | null = null

const plugin: VaultPlugin = {
  manifest: {
    id: 'plugin-pdf',
    name: 'PDF',
    version: '0.0.1',
    description: 'Le texte des PDF dans la recherche, et leur aperçu',
    scope: 'vault',
    permissions: ['ui:editor', 'vault:read'],
    defaultActive: true,
    // Verifie par l'equipe Savoire : peut tourner sur le pair indexeur du serveur.
    official: true,
  },
  async onload(api: PluginAPI) {
    unregister = api.extractors?.register(EXTRACTOR) ?? null
    for (const t of FILE_TYPES) {
      api.files.register({
        ...t,
        collaborationMode: 'none',
        creatable: false,
        create: async () => '',
        open: (path: string, ctx: FileContext) => createDocumentPreviewView(path, ctx, EXTRACTOR),
      })
    }
  },
  async onunload() {
    unregister?.()
    unregister = null
  },
}

export default plugin
