// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Colonnes dans une note (voir ADR-030). La syntaxe suit les blocs `:::` de
// Pandoc, Docusaurus et VitePress :
//
//   ::: colonnes 1 2
//   ![[photo.jpg]]
//   +++
//   Le texte a droite.
//   :::
//
// `+++` separe les colonnes. Apres le mot-cle : un seul nombre donne le
// nombre de colonnes (`colonnes 3`), plusieurs nombres donnent les largeurs
// (`1 2` : un tiers, deux tiers ; `30% 70%` marche aussi). Hors de Savoire,
// le bloc reste lisible : quelques lignes de marques, le contenu dans l'ordre.
//
// Ce fichier ne connait que le texte : lire un bloc, le reecrire. Le rendu
// et le glisser-deposer s'en servent.

import { markdownLanguage } from '@codemirror/lang-markdown'

const OPEN_RE = /^(:{3,})[ \t]*(colonnes|columns)\b[ \t]*(.*?)\s*$/i
const CLOSE_RE = /^:{3,}\s*$/
const SEPARATOR_RE = /^\s*\+\+\+\s*$/
const CODE_FENCE_RE = /^\s{0,3}(`{3,}|~{3,})/

/** Le mot-cle ecrit dans les blocs crees par Savoire. */
export const COLUMNS_KEYWORD = 'colonnes'

export interface ColumnRange {
  /** Debut de la premiere ligne de la colonne (ou place de la colonne vide). */
  from: number
  /** Fin de la derniere ligne. */
  to: number
  text: string
}

export interface ColumnsBlock {
  /** Debut de la ligne d'ouverture. */
  from: number
  /** Fin de la ligne de fermeture. */
  to: number
  /** Les deux-points d'ouverture (`:::`). */
  fence: string
  /** Ce qui suit le mot-cle (`1 2`). */
  header: string
  columns: ColumnRange[]
}

interface LineSource {
  readonly lines: number
  line(n: number): { from: number; to: number; text: string }
}

/** Lignes d'une chaine, au format de Text de CodeMirror (numerotees a partir de 1). */
export function linesOf(text: string): LineSource {
  const starts = [0]
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1)
  return {
    lines: starts.length,
    line(n: number) {
      const from = starts[n - 1]
      const to = n < starts.length ? starts[n] - 1 : text.length
      return { from, to, text: text.slice(from, to) }
    },
  }
}

/**
 * Tous les blocs de colonnes du document, dans l'ordre. Un bloc sans ligne
 * de fermeture n'en est pas un (il reste du texte), et les `:::` dans un bloc
 * de code ne comptent pas.
 */
export function findColumnsBlocks(doc: LineSource): ColumnsBlock[] {
  const blocks: ColumnsBlock[] = []
  let codeFence: string | null = null
  for (let n = 1; n <= doc.lines; n++) {
    const line = doc.line(n)
    const fence = CODE_FENCE_RE.exec(line.text)
    if (codeFence) {
      if (fence && fence[1][0] === codeFence[0] && fence[1].length >= codeFence.length) codeFence = null
      continue
    }
    if (fence) { codeFence = fence[1]; continue }
    const open = OPEN_RE.exec(line.text)
    if (!open) continue
    const block = readBlock(doc, n, open[1], open[3])
    if (!block) continue
    blocks.push(block.block)
    n = block.lastLine
  }
  return blocks
}

function readBlock(doc: LineSource, openLine: number, fence: string, header: string): { block: ColumnsBlock; lastLine: number } | null {
  const columns: ColumnRange[] = []
  let lines: string[] = []
  let start = -1
  let end = -1
  let emptyAt = doc.line(openLine).to + 1
  let codeFence: string | null = null
  const push = () => {
    // Le texte d'une colonne : ses lignes, sans les lignes vides du bord.
    const text = lines.join('\n').replace(/^(?:[ \t]*\n)+/, '').replace(/(?:\n[ \t]*)+$/, '')
    columns.push(start < 0 ? { from: emptyAt, to: emptyAt, text: '' } : { from: start, to: end, text: text.trim() ? text : '' })
    lines = []
    start = -1
    end = -1
  }
  for (let n = openLine + 1; n <= doc.lines; n++) {
    const line = doc.line(n)
    const fenceMatch = CODE_FENCE_RE.exec(line.text)
    if (codeFence) {
      if (fenceMatch && fenceMatch[1][0] === codeFence[0] && fenceMatch[1].length >= codeFence.length) codeFence = null
    } else if (fenceMatch) {
      codeFence = fenceMatch[1]
    } else if (CLOSE_RE.test(line.text)) {
      push()
      return { block: { from: doc.line(openLine).from, to: line.to, fence, header, columns }, lastLine: n }
    } else if (SEPARATOR_RE.test(line.text)) {
      push()
      emptyAt = line.to + 1
      continue
    }
    if (start < 0) start = line.from
    end = line.to
    lines.push(line.text)
  }
  return null
}

/** Le bloc de colonnes qui contient `pos`, ou null. */
export function columnsBlockAt(blocks: readonly ColumnsBlock[], pos: number): ColumnsBlock | null {
  return blocks.find(b => pos >= b.from && pos <= b.to) ?? null
}

/**
 * Largeurs relatives des colonnes, d'apres l'en-tete. `count` est le nombre
 * de colonnes ecrites ; un seul nombre dans l'en-tete peut en demander plus
 * (les colonnes manquantes sont vides).
 */
export function columnWidths(header: string, count: number): number[] {
  const tokens = header.split(/\s+/).filter(Boolean)
  const numbers = tokens.map(t => Number(t.replace(/%$/, '').replace(',', '.')))
  const valid = tokens.length > 0 && numbers.every(n => Number.isFinite(n) && n > 0)
  if (!valid) return Array(Math.max(1, count)).fill(1)
  if (tokens.length === 1 && !tokens[0].endsWith('%')) {
    return Array(Math.max(count, Math.min(6, Math.round(numbers[0])))).fill(1)
  }
  // Des largeurs : une par colonne ecrite, les manquantes a la moyenne.
  const widths = numbers.slice(0, Math.max(1, count))
  while (widths.length < count) widths.push(widths.reduce((a, b) => a + b, 0) / widths.length)
  return widths
}

/** L'en-tete apres l'ajout (at) ou le retrait d'une colonne. */
function headerAfter(header: string, count: number, change: { insert: number } | { remove: number }): string {
  const tokens = header.split(/\s+/).filter(Boolean)
  const numeric = tokens.length > 0 && tokens.every(t => /^\d+(?:[.,]\d+)?%?$/.test(t))
  if (!numeric) return header
  const next = 'insert' in change ? count + 1 : count - 1
  if (tokens.length === 1 && !tokens[0].endsWith('%')) return String(next)
  // Des largeurs : la nouvelle colonne prend la largeur moyenne.
  const percent = tokens.some(t => t.endsWith('%'))
  if ('insert' in change) {
    const values = tokens.map(t => Number(t.replace(/%$/, '').replace(',', '.')))
    const avg = values.reduce((a, b) => a + b, 0) / values.length
    const value = percent ? `${Math.round(avg)}%` : String(Math.round(avg) || 1)
    tokens.splice(change.insert, 0, value)
  } else {
    tokens.splice(change.remove, 1)
  }
  return tokens.length >= 2 ? tokens.join(' ') : ''
}

/** Le texte d'un bloc de colonnes. */
export function serializeColumns(fence: string, header: string, texts: readonly string[]): string {
  const head = `${fence} ${COLUMNS_KEYWORD}${header ? ` ${header}` : ''}`
  const body = texts.map(t => t.replace(/^\n+|\n+$/g, '')).join('\n+++\n')
  return `${head}\n${body}\n${fence}`
}

/** Un bloc de colonnes tout neuf autour de textes. */
export function newColumns(texts: readonly string[], header = ''): string {
  return serializeColumns(':::', header, texts)
}

// ── Morceaux d'une colonne ──────────────────────────────────────────────────

/** Les blocs de premier niveau d'un texte (paragraphe, liste, tableau...). */
export function markdownUnits(text: string): { from: number; to: number }[] {
  const out: { from: number; to: number }[] = []
  if (!text.trim()) return out
  const cursor = markdownLanguage.parser.parse(text).topNode.cursor()
  if (cursor.firstChild()) {
    do out.push({ from: cursor.from, to: cursor.to })
    while (cursor.nextSibling())
  }
  return out
}

/** Un bloc de colonnes, en morceaux qu'on deplace. */
export interface ColumnsModel {
  fence: string
  header: string
  /** Pour chaque colonne, ses blocs (texte brut). */
  columns: string[][]
}

export function modelOf(block: ColumnsBlock): ColumnsModel {
  return {
    fence: block.fence,
    header: block.header,
    columns: block.columns.map(c => markdownUnits(c.text).map(u => c.text.slice(u.from, u.to))),
  }
}

/**
 * Le texte du modele. Une colonne vide reste (on va y ecrire) ; une seule
 * colonne restante : le bloc disparait, son contenu reste.
 */
export function serializeModel(model: ColumnsModel): string {
  const cols = model.columns.map(c => c ?? [])
  if (cols.length === 0) return ''
  if (cols.length === 1) return cols[0].join('\n\n')
  return serializeColumns(model.fence, model.header, cols.map(c => c.join('\n\n')))
}

/** Retire un morceau ; une colonne videe disparait (et sa largeur). */
export function removeUnit(model: ColumnsModel, col: number, unit: number): string {
  const column = model.columns[col]
  const [removed] = column.splice(unit, 1)
  if (column.length === 0 && model.columns.length > 1) {
    model.header = headerAfter(model.header, model.columns.length, { remove: col })
    model.columns.splice(col, 1)
  }
  return removed ?? ''
}

/** Place un morceau dans une colonne, avant le morceau `unit` (a la fin par defaut). */
export function insertUnit(model: ColumnsModel, col: number, unit: number, text: string): void {
  const column = model.columns[col]
  column.splice(Math.max(0, Math.min(unit, column.length)), 0, text)
}

/** Ajoute une colonne a la place `col`, avec un premier morceau. */
export function insertColumn(model: ColumnsModel, col: number, text: string): void {
  model.header = headerAfter(model.header, model.columns.length, { insert: col })
  model.columns.splice(Math.max(0, Math.min(col, model.columns.length)), 0, [text])
}

/** Remplace tout le texte d'une colonne (edition directe d'une colonne). Videe, elle reste. */
export function setColumnText(model: ColumnsModel, col: number, text: string): void {
  while (model.columns.length <= col) model.columns.push([])
  model.columns[col] = markdownUnits(text).map(u => text.slice(u.from, u.to))
}
