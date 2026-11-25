// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// PDF : les cibles de la Revision (rectangles, liens, texte retrouve), le
// texte reconnu des pages scannees, et l'extraction qui s'en sert.
import { describe, it, expect } from 'vitest'
import {
  describePdfTarget, isPdfTarget, locatePdfQuote, newPdfRef, normalizePdfRects, parsePdfOcrPage, parsePdfSubpath, pdfOcrText,
  pdfRectsBounds, pdfWikiLink, type PdfOcrPage, type PdfTarget,
} from '@savoire/plugin-api'
import { EXTRACTOR, extractPdf, knownOcrPages, toOcrPage } from '@savoire/plugin-pdf'

const target = (over: Partial<PdfTarget> = {}): PdfTarget => ({ kind: 'pdf', page: 3, rects: [[0.1, 0.2, 0.3, 0.02]], quote: 'le passage', ref: 'k3x9qa', ...over })

describe('cibles dans un PDF', () => {
  it('reconnait une cible, et refuse un nom court qui n est pas sur', () => {
    expect(isPdfTarget(target())).toBe(true)
    expect(isPdfTarget(target({ ref: '../x' }))).toBe(false)
    expect(isPdfTarget(target({ page: 0 }))).toBe(false)
    expect(isPdfTarget({ kind: 'anim.time', start: 0 })).toBe(false)
    expect(newPdfRef(() => 0.5)).toMatch(/^[a-z0-9]{6}$/)
  })

  it('fond les rectangles d une meme ligne, garde les lignes a part, borne a la page', () => {
    const rects = normalizePdfRects([
      [0.1, 0.2, 0.1, 0.02], [0.2, 0.2005, 0.15, 0.02], // meme ligne, qui se touchent
      [0.1, 0.25, 0.3, 0.02], // ligne suivante
      [0.1, 0.25, 0.1, 0.02], // doublon contenu dans la precedente
      [0.95, 0.9, 0.2, 0.05], // deborde : coupe a la page
      [0.5, 0.5, 0, 0.01], // vide
    ])
    expect(rects).toHaveLength(3)
    expect(rects[0]![0]).toBeCloseTo(0.1)
    expect(rects[0]![2]).toBeCloseTo(0.25)
    expect(rects[2]).toEqual([0.95, 0.9, 0.05, 0.05])
    expect(pdfRectsBounds(rects)![0]).toBeCloseTo(0.1)
  })

  it('les liens : une page, une ancre, et leur lecture', () => {
    expect(pdfWikiLink('Rapport.pdf', { page: 3 })).toBe('[[Rapport.pdf#page=3]]')
    expect(pdfWikiLink('Rapport.pdf', { ref: 'k3x9qa' }, 'Tableau [1]')).toBe('[[Rapport.pdf#^k3x9qa|Tableau 1]]')
    expect(parsePdfSubpath('page=12')).toEqual({ page: 12 })
    expect(parsePdfSubpath('#p.4')).toEqual({ page: 4 })
    expect(parsePdfSubpath('^k3x9qa')).toEqual({ ref: 'k3x9qa' })
    expect(parsePdfSubpath('Introduction')).toBeNull()
    expect(parsePdfSubpath('page=0')).toBeNull()
  })

  it('se decrit en quelques mots', () => {
    expect(describePdfTarget(target())).toBe('p. 3 · « le passage »')
    expect(describePdfTarget(target({ quote: '', zone: true, label: 'Schéma' }))).toBe('p. 3 · Schéma · zone')
    expect(describePdfTarget(target({ quote: '', rects: [] }))).toBe('p. 3 · page entière')
  })

  it('retrouve un passage par son texte : coupures de ligne ignorees, page la plus proche, texte autour pour trancher', () => {
    const pages = ['Introduction.\nLe coût total du\nprojet est élevé.', 'Rien ici.', 'Annexe : le coût total du projet est élevé, encore.']
    expect(locatePdfQuote(pages, { quote: 'coût total du projet' }, 1)?.page).toBe(1)
    expect(locatePdfQuote(pages, { quote: 'coût total du projet' }, 3)?.page).toBe(3)
    // Le texte d'avant tranche, meme loin de la page attendue.
    expect(locatePdfQuote(pages, { quote: 'coût total du projet', prefix: 'Annexe : le' }, 1)?.page).toBe(3)
    const at = locatePdfQuote(pages, { quote: 'Le coût total' }, 1)!
    expect(pages[0]!.slice(at.from, at.to)).toBe('Le coût total')
    expect(locatePdfQuote(pages, { quote: 'absent du texte' }, 1)).toBeNull()
  })
})

describe('texte reconnu (OCR)', () => {
  const lines = [
    [{ text: 'FACTURE', x0: 100, y0: 50, x1: 300, y1: 90, confidence: 91 }, { text: 'N°12', x0: 320, y0: 50, x1: 400, y1: 90, confidence: 88 }],
    [{ text: 'Total', x0: 100, y0: 200, x1: 200, y1: 230, confidence: 95 }],
  ]

  it('les mots ramenes a la page, une ligne par ligne', () => {
    const page = toOcrPage(lines, 1000, 2000, 2, 'abc', new Date('2026-11-25T10:00:00Z'))
    expect(page).toMatchObject({ v: 1, page: 2, lines: [0, 2], fp: 'abc', at: '2026-11-25T10:00:00.000Z' })
    expect(page.words[0]).toEqual({ t: 'FACTURE', b: [0.1, 0.025, 0.2, 0.02], c: 91 })
    expect(pdfOcrText(page)).toBe('FACTURE N°12\nTotal')
    expect(parsePdfOcrPage(JSON.stringify(page))).toEqual(page)
    expect(parsePdfOcrPage('{"v":2}')).toBeNull()
  })

  it('l annexe : les pages de ce fichier seulement', () => {
    const p1 = toOcrPage(lines, 1000, 2000, 1, 'abc')
    const other = toOcrPage(lines, 1000, 2000, 2, 'autre')
    const known = knownOcrPages({ p1: JSON.stringify(p1), p2: JSON.stringify(other), p3: JSON.stringify(p1), extractor: 'x' }, 'abc')
    // p3 porte la page 1 : rangee sous la mauvaise cle, elle est ignoree.
    expect([...known.keys()]).toEqual([1])
  })
})

describe('extraction d un PDF scanne', () => {
  it('page sans texte : le texte deja reconnu, sinon l OCR ; la version de l extracteur change', async () => {
    expect(EXTRACTOR.version).toBe(3)
    expect(EXTRACTOR.annexes).toEqual(['ocr'])
    const pdf = minimalPdf(['Une vraie page de texte', ''])
    // Le texte deja garde dans le vault pour la page 2 : pas d'OCR.
    const kept: PdfOcrPage = { v: 1, page: 2, words: [{ t: 'Scanné', b: [0.1, 0.1, 0.2, 0.02] }, { t: 'lu', b: [0.35, 0.1, 0.05, 0.02] }], lines: [0], langs: ['fra'], at: '2026-11-25T10:00:00Z' }
    let calls = 0
    const engine = async () => { calls++; return [[{ text: 'Reconnu', x0: 10, y0: 10, x1: 90, y1: 30, confidence: 90 }]] }
    const withKept = await extractPdf(pdf, { known: new Map([[2, kept]]), ocr: engine })
    expect(calls).toBe(0)
    expect(withKept.sections.map(s => s.text)).toEqual(['Une vraie page de texte', 'Scanné lu'])
    expect(withKept.props).toMatchObject({ pages: 2, pages_reconnues: 1 })
    // Sans texte garde : l'OCR lit la page dessinee.
    const read = await extractPdf(pdf, { ocr: engine })
    expect(calls).toBe(1)
    expect(read.sections[1]).toEqual({ heading: 'Page 2', text: 'Reconnu' })
    // Sans OCR : la page n'a rien.
    const none = await extractPdf(pdf, { ocr: null })
    expect(none.sections.map(s => s.heading)).toEqual(['Page 1'])
  })

  it('l extracteur de l index lit l annexe « ocr » du fichier', async () => {
    const pdf = minimalPdf(['', 'Deuxième page'])
    const kept = toOcrPage([[{ text: 'Archive', x0: 0, y0: 0, x1: 10, y1: 10, confidence: 80 }]], 100, 100, 1)
    const asked: string[] = []
    const c = await EXTRACTOR.extract(pdf, { path: 'a.pdf', annex: async name => { asked.push(name); return { p1: JSON.stringify(kept) } } })
    expect(asked).toEqual(['ocr'])
    expect(c.sections[0]).toEqual({ heading: 'Page 1', text: 'Archive' })
  })
})

/** Un PDF minimal valide, une page par texte ('' : une page sans texte). */
function minimalPdf(pages: string[]): Uint8Array {
  const objs: string[] = []
  const kids = pages.map((_, i) => `${3 + i * 2} 0 R`).join(' ')
  objs.push('<< /Type /Catalog /Pages 2 0 R >>')
  objs.push(`<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`)
  const font = 3 + pages.length * 2
  pages.forEach((t, i) => {
    const stream = t ? `BT /F1 12 Tf 72 720 Td (${t}) Tj ET` : '0 0 1 rg 72 72 200 200 re f'
    objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${4 + i * 2} 0 R >>`)
    objs.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`)
  })
  objs.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')
  let out = '%PDF-1.4\n'
  const offsets: number[] = []
  objs.forEach((o, i) => { offsets.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n` })
  const xref = out.length
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map(o => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`
  return new TextEncoder().encode(out)
}
