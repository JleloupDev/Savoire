// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// pdf.js (Mozilla, Apache-2.0), charge a la premiere lecture, sans worker :
// le meme code tourne dans le navigateur, l'appli de bureau et le pair
// indexeur (Node).
//
// Ses fichiers annexes (decodeurs WebAssembly des images JBIG2 et JPEG 2000,
// polices standard, tables de caracteres) : servis par l'app sous
// /vendor/pdfjs/ (apps/web/vite.config.ts) ; sur le pair indexeur, un dossier
// donne par configurePdf (sans lui, une page scannee en JBIG2 ne se dessine pas).
/// <reference path="./worker.d.ts" />

export type PdfJs = typeof import('pdfjs-dist/legacy/build/pdf.mjs')
export type PdfDocument = Awaited<ReturnType<PdfJs['getDocument']>['promise']>
export type PdfPage = Awaited<ReturnType<PdfDocument['getPage']>>

let pdfjs: Promise<PdfJs> | null = null

/** pdf.js et son « worker » charges dans le meme fil (pas de fichier de worker a servir). */
export function loadPdfJs(): Promise<PdfJs> {
  pdfjs ??= (async () => {
    const lib = await import('pdfjs-dist/legacy/build/pdf.mjs')
    // Le module du worker s'inscrit dans globalThis.pdfjsWorker : pdf.js s'en sert sans worker.
    await import('pdfjs-dist/legacy/build/pdf.worker.mjs')
    return lib
  })().catch(err => { pdfjs = null; throw err })
  return pdfjs
}

/** Dossiers (ou adresses) des fichiers annexes de pdf.js, termines par « / ». */
export interface PdfAssets {
  wasmUrl?: string
  standardFontDataUrl?: string
  cMapUrl?: string
}

const configured: PdfAssets = {}

/** Le pair indexeur donne ici ses dossiers (chemins du disque). */
export function configurePdf(assets: PdfAssets): void {
  Object.assign(configured, assets)
}

function assets(): PdfAssets {
  if (typeof window === 'undefined' || typeof location === 'undefined') return configured
  const base = new URL('/vendor/pdfjs/', location.href).href
  return { wasmUrl: `${base}wasm/`, standardFontDataUrl: `${base}standard_fonts/`, cMapUrl: `${base}cmaps/`, ...configured }
}

/**
 * Ouvre un PDF. `render` : pour le dessiner (polices chargees) ; sinon pour
 * en lire le texte seulement.
 */
export async function openPdf(bytes: Uint8Array, render = false): Promise<{ doc: PdfDocument; destroy(): Promise<void> }> {
  const lib = await loadPdfJs()
  const task = lib.getDocument({
    data: bytes.slice(),
    disableFontFace: !render,
    useSystemFonts: render,
    verbosity: 0,
    ...assets(),
    ...(assets().cMapUrl ? { cMapPacked: true } : {}),
  })
  const doc = await task.promise
  return { doc, destroy: () => task.destroy() }
}

/** Le texte d'une page (lignes rendues par pdf.js), propre. */
export async function pageText(page: PdfPage): Promise<string> {
  const content = await page.getTextContent()
  let text = ''
  for (const item of content.items as { str?: string; hasEOL?: boolean }[]) {
    if (typeof item.str !== 'string') continue
    text += item.str + (item.hasEOL ? '\n' : '')
  }
  return text.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
}
