// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Extracteurs des suites bureautiques : Word, PowerPoint, Excel (Office Open
// XML) et OpenDocument (LibreOffice). Ce sont des archives .zip de XML : le
// texte se lit sans bibliotheque.
import { readZip, type ArchiveFile, type ExtractedContent, type ExtractedSection, type PropertyValue } from '@savoire/plugin-api'
import { attr, decodeEntities, elements, firstText, textOf } from './xml'

/** Lignes au plus par feuille de calcul (l'apercu et l'index n'en gardent pas plus). */
export const MAX_ROWS = 2000

const dec = new TextDecoder('utf-8')

async function open(bytes: Uint8Array): Promise<Map<string, string>> {
  const files = new Map<string, string>()
  let entries: ArchiveFile[]
  try { entries = await readZip(bytes, 3) } catch { throw new Error('Fichier abîmé ou chiffré : ce n’est pas une archive Office lisible.') }
  for (const f of entries) if (/\.(xml|rels)$/i.test(f.path)) files.set(f.path, dec.decode(f.bytes))
  return files
}

/** Metadonnees Office (docProps/core.xml). */
function officeProps(files: Map<string, string>): { title?: string; props: Record<string, PropertyValue> } {
  const core = files.get('docProps/core.xml') ?? ''
  const props: Record<string, PropertyValue> = {}
  const author = firstText(core, 'dc:creator')
  const created = firstText(core, 'dcterms:created')
  const modified = firstText(core, 'dcterms:modified')
  const subject = firstText(core, 'dc:subject')
  if (author) props.auteur = author
  if (created) props.cree_le = created.slice(0, 10)
  if (modified) props.modifie_le = modified.slice(0, 10)
  if (subject) props.sujet = subject
  return { title: firstText(core, 'dc:title'), props }
}

// ── Word ───────────────────────────────────────────────────────────────────

/** Style de titre d'un paragraphe Word (Heading1, Titre1, Title...). */
function headingLevel(pPr: string): number | null {
  const style = /<w:pStyle\s+w:val="([^"]+)"/.exec(pPr)?.[1] ?? ''
  if (/^(Title|Titre)$/i.test(style)) return 0
  const m = /^(?:Heading|Titre|berschrift|Kop)(\d)$/i.exec(style)
  return m ? Number(m[1]) : null
}

export async function extractDocx(bytes: Uint8Array): Promise<ExtractedContent> {
  const files = await open(bytes)
  const doc = files.get('word/document.xml')
  if (!doc) throw new Error('Document Word sans contenu (word/document.xml absent).')
  const meta = officeProps(files)
  const sections: ExtractedSection[] = [{ text: '' }]
  let title = meta.title
  for (const p of elements(doc, 'w:p')) {
    const inner = p.inner.replace(/<w:tab\/>/g, '<w:t>\t</w:t>').replace(/<w:br\/>/g, '<w:t>\n</w:t>')
    const text = textOf(inner, ['w:t']).trim()
    if (!text) continue
    const level = headingLevel(/<w:pPr>[\s\S]*?<\/w:pPr>/.exec(inner)?.[0] ?? '')
    if (level === 0 && !title) { title = text; continue }
    if (level !== null && level > 0) { sections.push({ heading: text, text: '' }); continue }
    const s = sections[sections.length - 1]
    s.text += (s.text ? '\n' : '') + text
  }
  return { title, sections: sections.filter(s => s.heading || s.text), props: meta.props }
}

// ── PowerPoint ─────────────────────────────────────────────────────────────

export async function extractPptx(bytes: Uint8Array): Promise<ExtractedContent> {
  const files = await open(bytes)
  const meta = officeProps(files)
  const slides = [...files.keys()]
    .filter(p => /^ppt\/slides\/slide\d+\.xml$/.test(p))
    .sort((a, b) => Number(/(\d+)\.xml$/.exec(a)![1]) - Number(/(\d+)\.xml$/.exec(b)![1]))
  const sections = slides.map((path, i) => {
    const lines = elements(files.get(path)!, 'a:p').map(p => textOf(p.inner, ['a:t']).trim()).filter(Boolean)
    // La premiere ligne d'une diapositive est le plus souvent son titre.
    return { heading: `Diapositive ${i + 1}${lines[0] ? ` : ${lines[0]}` : ''}`, text: lines.slice(1).join('\n') }
  })
  return { title: meta.title, sections, props: { ...meta.props, diapositives: slides.length } }
}

// ── Excel ──────────────────────────────────────────────────────────────────

/** « B3 » -> colonne 1 (a partir de 0). */
function columnOf(ref: string): number {
  let n = 0
  for (const c of /^[A-Z]+/.exec(ref)?.[0] ?? 'A') n = n * 26 + (c.charCodeAt(0) - 64)
  return n - 1
}

export async function extractXlsx(bytes: Uint8Array): Promise<ExtractedContent> {
  const files = await open(bytes)
  const meta = officeProps(files)
  const shared = elements(files.get('xl/sharedStrings.xml') ?? '', 'si').map(si => textOf(si.inner, ['t']))
  const rels = new Map(elements(files.get('xl/_rels/workbook.xml.rels') ?? '', 'Relationship')
    .map(r => [attr(r.attrs, 'Id') ?? '', (attr(r.attrs, 'Target') ?? '').replace(/^\/?xl\//, '')]))
  const sheets = elements(files.get('xl/workbook.xml') ?? '', 'sheet').map(s => ({
    name: attr(s.attrs, 'name') ?? 'Feuille',
    path: `xl/${rels.get(attr(s.attrs, 'r:id') ?? '') ?? ''}`,
  }))
  const sections: ExtractedSection[] = []
  for (const sheet of sheets) {
    const xml = files.get(sheet.path)
    if (!xml) continue
    const rows: string[][] = []
    for (const row of elements(xml, 'row').slice(0, MAX_ROWS)) {
      const cells: string[] = []
      for (const c of elements(row.inner, 'c')) {
        const type = attr(c.attrs, 't')
        const col = columnOf(attr(c.attrs, 'r') ?? 'A')
        const v = firstText(c.inner, 'v')
        const value = type === 's' ? shared[Number(v)] ?? ''
          : type === 'inlineStr' ? textOf(c.inner, ['t'])
          : type === 'b' ? (v === '1' ? 'VRAI' : 'FAUX')
          : decodeEntities(v ?? '')
        while (cells.length < col) cells.push('')
        cells[col] = value
      }
      if (cells.some(x => x)) rows.push(cells)
    }
    sections.push({ heading: sheet.name, text: rows.map(r => r.join('\t')).join('\n'), rows })
  }
  return { title: meta.title, sections, props: { ...meta.props, feuilles: sheets.length } }
}

// ── OpenDocument (LibreOffice) ─────────────────────────────────────────────

export async function extractOpenDocument(bytes: Uint8Array): Promise<ExtractedContent> {
  const files = await open(bytes)
  const content = files.get('content.xml')
  if (!content) throw new Error('Document OpenDocument sans contenu (content.xml absent).')
  const meta = files.get('meta.xml') ?? ''
  const props: Record<string, PropertyValue> = {}
  const author = firstText(meta, 'meta:initial-creator') ?? firstText(meta, 'dc:creator')
  const created = firstText(meta, 'meta:creation-date')
  if (author) props.auteur = author
  if (created) props.cree_le = created.slice(0, 10)
  const title = firstText(meta, 'dc:title')
  const body = /<office:body>([\s\S]*)<\/office:body>/.exec(content)?.[1] ?? content
  const sections: ExtractedSection[] = []

  // Classeur : une section par feuille, en tableau.
  const tables = elements(body, 'table:table')
  if (/<office:spreadsheet>/.test(body)) {
    for (const t of tables) {
      const rows = elements(t.inner, 'table:table-row').slice(0, MAX_ROWS).map(r =>
        elements(r.inner, 'table:table-cell').map(c => elements(c.inner, 'text:p').map(p => decodeEntities(p.inner.replace(/<[^>]+>/g, ''))).join(' ')),
      ).filter(r => r.some(x => x))
      sections.push({ heading: attr(t.attrs, 'table:name') ?? 'Feuille', text: rows.map(r => r.join('\t')).join('\n'), rows })
    }
    return { title, sections, props }
  }
  // Presentation : une section par page.
  if (/<office:presentation>/.test(body)) {
    elements(body, 'draw:page').forEach((page, i) => {
      const lines = elements(page.inner, 'text:p').map(p => decodeEntities(p.inner.replace(/<[^>]+>/g, '')).trim()).filter(Boolean)
      sections.push({ heading: `Diapositive ${i + 1}${lines[0] ? ` : ${lines[0]}` : ''}`, text: lines.slice(1).join('\n') })
    })
    return { title, sections, props }
  }
  // Texte : titres (text:h) et paragraphes (text:p), dans l'ordre.
  sections.push({ text: '' })
  for (const m of body.matchAll(/<text:(h|p)(\s[^>]*)?>([\s\S]*?)<\/text:\1>/g)) {
    const text = decodeEntities(m[3].replace(/<text:tab\/>/g, '\t').replace(/<text:line-break\/>/g, '\n').replace(/<[^>]+>/g, '')).trim()
    if (!text) continue
    if (m[1] === 'h') sections.push({ heading: text, text: '' })
    else {
      const s = sections[sections.length - 1]
      s.text += (s.text ? '\n' : '') + text
    }
  }
  return { title, sections: sections.filter(s => s.heading || s.text), props }
}
