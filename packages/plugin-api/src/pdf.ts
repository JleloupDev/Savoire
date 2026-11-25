// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// PDF : ce qu'on vise dans un PDF (un passage, une zone, une page), son lien,
// et le texte reconnu d'une page scannee (OCR). Tout est pur ici : la vue du
// PDF (plugin-pdf), la Revision, le contexte de l'IA et le pair indexeur
// lisent les memes formes.
//
// Une cible (PdfTarget) est ce que vise un fil de la Revision sur un PDF :
//  - un surlignage (mark 'highlight') : un passage colore, avec ou sans commentaire ;
//  - une ancre (mark 'anchor') : un passage ou une zone nommes, a citer ailleurs ;
//  - un commentaire (mark absent) sur un passage ou une zone.
// Elle tient la page, les rectangles (fractions de la page, 0 a 1, dans le
// sens ou la page s'affiche), le texte cite et un peu de texte autour : si le
// fichier est remplace par une autre version, le texte retrouve le passage.
// `ref` est son nom court, celui des liens : [[Rapport.pdf#^k3x9qa]].
// Une page se vise aussi seule : [[Rapport.pdf#page=3]].

/** Un rectangle d'une page : x, y (coin haut gauche), largeur, hauteur, en fractions de la page. */
export type PdfRect = [number, number, number, number]

/** Couleurs des surlignages (nom -> couleur affichee). */
export const PDF_COLORS = {
  jaune: '#facc15',
  vert: '#4ade80',
  bleu: '#60a5fa',
  rose: '#f472b6',
  orange: '#fb923c',
} as const

export type PdfColor = keyof typeof PDF_COLORS

export interface PdfTarget {
  kind: 'pdf'
  /** Page, a partir de 1. */
  page: number
  /** Ce qui est vise sur la page ; vide : la page entiere. */
  rects: PdfRect[]
  /** Le texte vise ('' : une zone sans texte, une page). */
  quote: string
  /** Un peu du texte juste avant et juste apres (32 caracteres au plus). */
  prefix?: string
  suffix?: string
  /** Surlignage ou ancre nommee ; absent : un commentaire. */
  mark?: 'highlight' | 'anchor'
  /** Nom court, pour les liens (#^ref). */
  ref: string
  color?: PdfColor
  /** Nom d'une ancre (« Tableau des couts »). */
  label?: string
  /** Une zone tracee a la souris (un rectangle), pas un passage du texte. */
  zone?: boolean
  /** Empreinte du fichier quand on a vise (pdf.js) : autre empreinte, autre version. */
  fp?: string
}

export const MAX_PDF_RECTS = 64
export const MAX_PDF_QUOTE = 2000
export const PDF_SIDE_CHARS = 32

const REF_RE = /^[a-z0-9]{4,16}$/

export function isPdfTarget(v: unknown): v is PdfTarget {
  const t = v as PdfTarget | null
  return !!t && typeof t === 'object' && t.kind === 'pdf' && Number.isInteger(t.page) && t.page >= 1
    && Array.isArray(t.rects) && typeof t.quote === 'string' && typeof t.ref === 'string' && REF_RE.test(t.ref)
}

/** Un nom court tout neuf, pour une cible (6 caracteres, minuscules et chiffres). */
export function newPdfRef(random: () => number = Math.random): string {
  let s = ''
  for (let i = 0; i < 6; i++) s += '0123456789abcdefghijklmnopqrstuvwxyz'[Math.floor(random() * 36)]
  return s
}

const clamp01 = (x: number) => Math.max(0, Math.min(1, x))
const r4 = (x: number) => Math.round(x * 10000) / 10000

/**
 * Des rectangles propres : bornes a la page, arrondis, sans les minuscules,
 * et ceux d'une meme ligne qui se touchent fondus en un. 64 au plus.
 */
export function normalizePdfRects(rects: readonly PdfRect[]): PdfRect[] {
  const clean: PdfRect[] = []
  for (const r of rects) {
    if (!Array.isArray(r) || r.length !== 4 || r.some(n => typeof n !== 'number' || !Number.isFinite(n))) continue
    const x0 = clamp01(Math.min(r[0], r[0] + r[2])), x1 = clamp01(Math.max(r[0], r[0] + r[2]))
    const y0 = clamp01(Math.min(r[1], r[1] + r[3])), y1 = clamp01(Math.max(r[1], r[1] + r[3]))
    if (x1 - x0 < 0.0005 || y1 - y0 < 0.0005) continue
    clean.push([x0, y0, x1 - x0, y1 - y0])
  }
  // Par ligne (milieux a la meme hauteur), puis de gauche a droite : les morceaux
  // qui se touchent ou se chevauchent sont fondus en un.
  clean.sort((a, b) => (a[1] + a[3] / 2) - (b[1] + b[3] / 2))
  const lines: PdfRect[][] = []
  for (const r of clean) {
    const line = lines[lines.length - 1]
    const ref = line?.[0]
    if (ref && Math.abs((ref[1] + ref[3] / 2) - (r[1] + r[3] / 2)) < Math.min(ref[3], r[3]) * 0.5) line!.push(r)
    else lines.push([r])
  }
  const out: PdfRect[] = []
  for (const line of lines) {
    line.sort((a, b) => a[0] - b[0])
    let cur: PdfRect | null = null
    for (const r of line) {
      if (cur && r[0] <= cur[0] + cur[2] + Math.max(cur[3], r[3]) * 0.6) {
        const x0 = Math.min(cur[0], r[0]), y0 = Math.min(cur[1], r[1])
        const x1 = Math.max(cur[0] + cur[2], r[0] + r[2]), y1 = Math.max(cur[1] + cur[3], r[1] + r[3])
        cur = [x0, y0, x1 - x0, y1 - y0]
      } else {
        if (cur) out.push(cur)
        cur = r
      }
    }
    if (cur) out.push(cur)
  }
  return out.slice(0, MAX_PDF_RECTS).map(r => [r4(r[0]), r4(r[1]), r4(r[2]), r4(r[3])])
}

/** Le rectangle qui contient tous les autres (null : aucun). */
export function pdfRectsBounds(rects: readonly PdfRect[]): PdfRect | null {
  if (!rects.length) return null
  let x0 = 1, y0 = 1, x1 = 0, y1 = 0
  for (const r of rects) {
    x0 = Math.min(x0, r[0]); y0 = Math.min(y0, r[1])
    x1 = Math.max(x1, r[0] + r[2]); y1 = Math.max(y1, r[1] + r[3])
  }
  return [x0, y0, Math.max(0, x1 - x0), Math.max(0, y1 - y0)]
}

/** Deux rectangles se recouvrent-ils (d'au moins la moitie du plus petit, `ratio`) ? */
export function pdfRectsOverlap(a: PdfRect, b: PdfRect, ratio = 0.5): boolean {
  const w = Math.min(a[0] + a[2], b[0] + b[2]) - Math.max(a[0], b[0])
  const h = Math.min(a[1] + a[3], b[1] + b[3]) - Math.max(a[1], b[1])
  if (w <= 0 || h <= 0) return false
  return w * h >= ratio * Math.min(a[2] * a[3], b[2] * b[3])
}

// ── Liens ───────────────────────────────────────────────────────────────────

/** Ce que vise la suite d'un lien vers un PDF (« page=3 », « ^k3x9qa »). Null : rien de connu. */
export function parsePdfSubpath(subpath: string): { page: number } | { ref: string } | null {
  const s = subpath.trim().replace(/^#/, '')
  const page = /^(?:page=|p\.?\s?)(\d{1,5})$/i.exec(s)
  if (page) { const n = Number(page[1]); return n >= 1 ? { page: n } : null }
  const ref = /^\^([a-z0-9]{4,16})$/.exec(s)
  return ref ? { ref: ref[1] } : null
}

/** La suite d'un lien : « page=3 » ou « ^ref ». */
export function pdfSubpath(to: { page: number } | { ref: string }): string {
  return 'ref' in to ? `^${to.ref}` : `page=${to.page}`
}

/** Le lien d'une note vers ce PDF : [[Rapport.pdf#page=3]], [[Rapport.pdf#^ref]]. `target` : le nom (ou chemin) du fichier. */
export function pdfWikiLink(target: string, to: { page: number } | { ref: string }, alias?: string): string {
  const clean = alias?.replace(/[[\]|]/g, ' ').replace(/\s+/g, ' ').trim()
  return `[[${target}#${pdfSubpath(to)}${clean ? `|${clean}` : ''}]]`
}

/** Une cible en quelques mots : « p. 3 · « le passage » », « p. 3 · zone ». */
export function describePdfTarget(t: Pick<PdfTarget, 'page' | 'quote' | 'zone' | 'label' | 'rects'>, max = 80): string {
  const where = `p. ${t.page}`
  const label = t.label?.trim()
  const quote = t.quote.replace(/\s+/g, ' ').trim()
  const short = quote.length > max ? `${quote.slice(0, max - 1)}…` : quote
  const what = short ? `« ${short} »` : t.zone ? 'zone' : t.rects.length ? 'passage' : 'page entière'
  return label ? `${where} · ${label} · ${what}` : `${where} · ${what}`
}

// ── Retrouver un passage par son texte ───────────────────────────────────────

/** Un texte sans ses espaces (les coupures de ligne d'un PDF n'y comptent plus). */
function squash(s: string): { text: string; map: number[] } {
  let text = ''
  const map: number[] = []
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!
    if (/\s/.test(c) || c === '­') continue
    text += c.toLowerCase()
    map.push(i)
  }
  return { text, map }
}

/**
 * La page ou se trouve un passage, d'apres son texte : la page `preferred`
 * si elle le contient, sinon la plus proche qui le contient (avec le texte
 * d'avant et d'apres s'il le faut pour trancher). Espaces et coupures de
 * ligne ne comptent pas. Null : introuvable.
 */
export function locatePdfQuote(pages: readonly string[], target: Pick<PdfTarget, 'quote' | 'prefix' | 'suffix'>, preferred = 1): { page: number; from: number; to: number } | null {
  const q = squash(target.quote).text
  if (q.length < 3) return null
  const found: { page: number; from: number; to: number; exact: boolean }[] = []
  pages.forEach((raw, i) => {
    const { text, map } = squash(raw)
    for (let at = text.indexOf(q); at >= 0 && found.length < 200; at = text.indexOf(q, at + 1)) {
      const pre = squash(target.prefix ?? '').text
      const suf = squash(target.suffix ?? '').text
      const exact = (!pre || text.slice(Math.max(0, at - pre.length), at) === pre) && (!suf || text.slice(at + q.length, at + q.length + suf.length) === suf)
      found.push({ page: i + 1, from: map[at]!, to: map[at + q.length - 1]! + 1, exact })
    }
  })
  if (!found.length) return null
  const pool = found.some(f => f.exact) ? found.filter(f => f.exact) : found
  pool.sort((a, b) => Math.abs(a.page - preferred) - Math.abs(b.page - preferred) || a.from - b.from)
  const best = pool[0]!
  return { page: best.page, from: best.from, to: best.to }
}

// ── Texte reconnu (OCR) ──────────────────────────────────────────────────────
//
// Une page scannee n'a pas de texte : seulement une image. Le texte qu'y
// reconnait l'OCR (Tesseract) est garde dans le vault, dans l'annexe « ocr »
// du PDF (un document CRDT rattache), une cle par page (« p3 », JSON). Il est
// fait une fois pour tous : par la vue du PDF du premier membre qui l'ouvre,
// et le pair indexeur s'en sert pour la recherche au lieu de refaire l'OCR.

/** Nom de l'annexe du texte reconnu d'un PDF. */
export const PDF_OCR_ANNEX = 'ocr'

/** Un mot reconnu : son texte, sa place (fractions de la page), la confiance (0 a 100). */
export interface PdfOcrWord {
  t: string
  b: PdfRect
  c?: number
}

export interface PdfOcrPage {
  v: 1
  page: number
  /** Les mots, dans l'ordre de lecture. */
  words: PdfOcrWord[]
  /** Indices des mots qui ouvrent une ligne (le premier compris). */
  lines: number[]
  /** Langues (codes Tesseract). */
  langs: string[]
  /** Date ISO. */
  at: string
  /** Empreinte du fichier lu (une autre version se relit). */
  fp?: string
}

/** Cle d'une page dans l'annexe « ocr ». */
export const pdfOcrKey = (page: number): string => `p${page}`

export function isPdfOcrPage(v: unknown): v is PdfOcrPage {
  const p = v as PdfOcrPage | null
  return !!p && typeof p === 'object' && p.v === 1 && Number.isInteger(p.page) && Array.isArray(p.words) && Array.isArray(p.lines)
}

/** Lit une page de l'annexe (JSON) ; null si illisible. */
export function parsePdfOcrPage(raw: unknown): PdfOcrPage | null {
  try {
    const v = typeof raw === 'string' ? JSON.parse(raw) : raw
    return isPdfOcrPage(v) ? v : null
  } catch {
    return null
  }
}

/** Le texte d'une page reconnue : les mots d'une ligne separes d'une espace, une ligne par ligne. */
export function pdfOcrText(page: Pick<PdfOcrPage, 'words' | 'lines'>): string {
  const starts = new Set(page.lines)
  let out = ''
  page.words.forEach((w, i) => {
    if (i > 0) out += starts.has(i) ? '\n' : ' '
    out += w.t
  })
  return out
}
