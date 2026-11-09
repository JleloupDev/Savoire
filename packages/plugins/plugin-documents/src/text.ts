// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Extracteurs des formats texte : HTML, texte brut, CSV.
import type { ExtractedContent, ExtractedSection } from '@savoire/plugin-api'
import { decodeEntities } from './xml'
import { MAX_ROWS } from './office'

const decode = (b: Uint8Array) => {
  const t = new TextDecoder('utf-8').decode(b)
  return t.charCodeAt(0) === 0xfeff ? t.slice(1) : t
}

const clean = (html: string) => decodeEntities(html.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li|tr|h\d)>/gi, '\n').replace(/<[^>]+>/g, ''))
  .replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim()

export async function extractHtml(bytes: Uint8Array): Promise<ExtractedContent> {
  const html = decode(bytes).replace(/<(script|style|noscript|template)[\s\S]*?<\/\1>/gi, '').replace(/<!--[\s\S]*?-->/g, '')
  const title = clean(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? '') || undefined
  const body = /<body[^>]*>([\s\S]*)<\/body>/i.exec(html)?.[1] ?? html
  const sections: ExtractedSection[] = []
  // Une section par titre h1-h3 ; le texte d'avant le premier titre a part.
  const parts = body.split(/(<h[1-3][^>]*>[\s\S]*?<\/h[1-3]>)/i)
  let current: ExtractedSection = { text: '' }
  for (const part of parts) {
    const h = /^<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>$/i.exec(part)
    if (h) { if (current.heading || current.text) sections.push(current); current = { heading: clean(h[1]), text: '' }; continue }
    const t = clean(part)
    if (t) current.text += (current.text ? '\n' : '') + t
  }
  if (current.heading || current.text) sections.push(current)
  const description = /<meta\s+name=["']description["']\s+content=["']([^"']*)["']/i.exec(html)?.[1]
  return { title, sections, ...(description ? { props: { description: decodeEntities(description) } } : {}) }
}

export async function extractText(bytes: Uint8Array): Promise<ExtractedContent> {
  return { sections: [{ text: decode(bytes) }] }
}

/** Separateur d'un CSV : celui qui revient le plus sur la premiere ligne. */
function separator(line: string): string {
  const counts = [',', ';', '\t'].map(s => [s, line.split(s).length] as const)
  return counts.sort((a, b) => b[1] - a[1])[0][0]
}

export function parseDelimited(text: string, sep: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++ } else if (c === '"') quoted = false
      else field += c
    } else if (c === '"' && field === '') quoted = true
    else if (c === sep) { row.push(field); field = '' }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++
      row.push(field); field = ''; rows.push(row); row = []
      if (rows.length >= MAX_ROWS) return rows
    } else field += c
  }
  if (field || row.length) { row.push(field); rows.push(row) }
  return rows.filter(r => r.some(x => x !== ''))
}

export async function extractCsv(bytes: Uint8Array): Promise<ExtractedContent> {
  const text = decode(bytes)
  const rows = parseDelimited(text, separator(text.split('\n', 1)[0] ?? ''))
  return {
    sections: [{ text: rows.map(r => r.join('\t')).join('\n'), rows }],
    props: { lignes: Math.max(0, rows.length - 1), colonnes: rows[0]?.length ?? 0 },
  }
}
