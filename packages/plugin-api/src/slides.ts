// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Format « slides » : une note Markdown qui devient une presentation, comme
// Marp ou reveal.js. Logique pure, partagee par l'editeur (presentation,
// export) et les outils d'agent (inserer dans une diapositive).
//
//  - Activation : la propriete `type: slides` (ou `présentation`).
//  - Separateur : une ligne `---` seule, PRECEDEE D'UNE LIGNE VIDE (ou en
//    tete du corps). C'est la regle de Marp. Elle leve les deux conflits :
//      · le frontmatter : seul le bloc `---` de la premiere ligne en est un,
//        il est retire avant le decoupage ;
//      · le titre Setext : `Texte` puis `---` colle dessous reste un titre,
//        la ligne vide manque.
//    Dans un bloc de code ou de maths, rien n'est coupe. Pour un trait
//    horizontal dans une diapositive : `***` ou `___`.
//  - Notes du presentateur : une ligne `Notes :` (ou `Note:`), seule ou
//    suivie du debut des notes ; tout ce qui suit dans la diapositive.
//  - Reglages, dans les proprietes : `thème` (clair, sombre, bleu, sépia),
//    `format` (16:9, 4:3), `numéros` (oui / non), `pied` (texte en bas).
import { findFrontmatter, parseFrontmatter } from './properties'

export const SLIDE_THEMES = ['clair', 'sombre', 'bleu', 'sépia'] as const
export type SlideTheme = typeof SLIDE_THEMES[number]

export type SlideRatio = '16:9' | '4:3'

export interface Slide {
  /** Rang, a partir de 0. */
  index: number
  /** Debut et fin de la diapositive dans le texte de la note (separateur exclu). */
  from: number
  to: number
  /** Le contenu montre, sans les notes. */
  markdown: string
  /** Les notes du presentateur ('' : aucune). */
  notes: string
  /** Debut des notes dans le texte de la note (-1 : aucune). */
  notesFrom: number
  /** Le premier titre de la diapositive ('' : aucun). */
  title: string
  /** Diapositive de titre : elle commence par un titre de niveau 1 (centree). */
  cover: boolean
}

export interface SlideDeck {
  slides: Slide[]
  theme: SlideTheme
  ratio: SlideRatio
  /** Numero de la diapositive en bas a droite. */
  numbers: boolean
  /** Texte en bas a gauche de chaque diapositive ('' : aucun). */
  footer: string
  /** Debut du corps (apres le frontmatter). */
  bodyFrom: number
}

const SLIDES_TYPES = new Set(['slides', 'slide', 'présentation', 'presentation', 'diapositives', 'diaporama'])

const fold = (s: string): string => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim()

/** Lit une propriete sous l'un de ses noms (« thème », « theme »...). */
function prop(props: Record<string, unknown>, names: string[]): unknown {
  const wanted = new Set(names.map(fold))
  for (const [k, v] of Object.entries(props)) if (wanted.has(fold(k))) return v
  return undefined
}

/** La note est-elle une presentation (`type: slides`) ? */
export function isSlidesNote(text: string): boolean {
  if (!text.startsWith('---')) return false
  const type = prop(parseFrontmatter(text), ['type'])
  const values = Array.isArray(type) ? type : [type]
  return values.some(v => typeof v === 'string' && SLIDES_TYPES.has(v.toLowerCase().trim()))
}

const NOTES_LINE = /^(?:notes?|note du présentateur|notes du présentateur)\s*:\s?(.*)$/i
const SEPARATOR_LINE = /^---[ \t]*$/
const FENCE = /^ {0,3}(`{3,}|~{3,})/
const MATH_FENCE = /^ {0,3}\$\$[ \t]*$/

interface Line { from: number; to: number; text: string }

function linesOf(text: string, from: number): Line[] {
  const out: Line[] = []
  let at = from
  while (at <= text.length) {
    const nl = text.indexOf('\n', at)
    const end = nl < 0 ? text.length : nl
    out.push({ from: at, to: end, text: text.slice(at, end).replace(/\r$/, '') })
    if (nl < 0) break
    at = nl + 1
  }
  return out
}

/**
 * Les lignes separatrices du corps : debut de chaque ligne `---` qui coupe
 * deux diapositives. Hors code et maths, precedee d'une ligne vide.
 */
export function slideSeparators(text: string, bodyFrom = findFrontmatter(text)?.end ?? 0): Line[] {
  const out: Line[] = []
  let fence: string | null = null
  let math = false
  let blankBefore = true
  for (const line of linesOf(text, bodyFrom)) {
    const t = line.text
    if (fence) {
      if (t.trimStart().startsWith(fence)) fence = null
      blankBefore = false
      continue
    }
    if (math) {
      if (MATH_FENCE.test(t)) math = false
      blankBefore = false
      continue
    }
    const f = FENCE.exec(t)
    if (f) { fence = f[1]!; blankBefore = false; continue }
    if (MATH_FENCE.test(t)) { math = true; blankBefore = false; continue }
    if (SEPARATOR_LINE.test(t) && blankBefore) {
      out.push(line)
      // Deux separateurs de suite : une diapositive vide entre eux.
      blankBefore = true
      continue
    }
    blankBefore = t.trim() === ''
  }
  return out
}

function headingOf(markdown: string): { title: string; level: number } {
  let fence = false
  for (const raw of markdown.split('\n')) {
    const t = raw.replace(/\r$/, '')
    if (FENCE.test(t)) { fence = !fence; continue }
    if (fence) continue
    const m = /^ {0,3}(#{1,6})[ \t]+(.+?)[ \t#]*$/.exec(t)
    if (m) return { title: m[2]!.trim(), level: m[1]!.length }
  }
  return { title: '', level: 0 }
}

/** Le premier bloc non vide est-il un titre de niveau 1 ? */
function startsWithH1(markdown: string): boolean {
  const first = markdown.split('\n').find(l => l.trim() !== '')
  return !!first && /^ {0,3}#[ \t]+\S/.test(first)
}

/** Coupe une diapositive en contenu et notes du presentateur. */
function splitNotes(text: string, from: number, to: number): { markdown: string; notes: string; notesFrom: number } {
  let fence = false
  for (const line of linesOf(text.slice(0, to), from)) {
    if (line.from >= to) break
    if (FENCE.test(line.text)) { fence = !fence; continue }
    if (fence) continue
    const m = NOTES_LINE.exec(line.text)
    if (!m) continue
    const rest = text.slice(Math.min(line.to + 1, to), to)
    const notes = [m[1] ?? '', rest].filter(s => s.trim() !== '').join('\n').trim()
    return { markdown: text.slice(from, line.from).trim(), notes, notesFrom: line.from }
  }
  return { markdown: text.slice(from, to).trim(), notes: '', notesFrom: -1 }
}

function yes(v: unknown, fallback: boolean): boolean {
  if (typeof v === 'boolean') return v
  if (typeof v !== 'string') return fallback
  const s = fold(v)
  if (['non', 'no', 'false', 'faux', '0', 'off'].includes(s)) return false
  if (['oui', 'yes', 'true', 'vrai', '1', 'on'].includes(s)) return true
  return fallback
}

function themeOf(v: unknown): SlideTheme {
  const s = typeof v === 'string' ? fold(v) : ''
  const aliases: Record<string, SlideTheme> = {
    clair: 'clair', light: 'clair', blanc: 'clair',
    sombre: 'sombre', dark: 'sombre', noir: 'sombre',
    bleu: 'bleu', blue: 'bleu', nuit: 'bleu',
    sepia: 'sépia', papier: 'sépia', paper: 'sépia',
  }
  return aliases[s] ?? 'clair'
}

/** La presentation : ses diapositives et ses reglages. */
export function slideDeck(text: string): SlideDeck {
  const fm = findFrontmatter(text)
  const props = fm ? parseFrontmatter(text) as Record<string, unknown> : {}
  const bodyFrom = fm?.end ?? 0
  const seps = slideSeparators(text, bodyFrom)
  const bounds: { from: number; to: number }[] = []
  let at = bodyFrom
  for (const s of seps) {
    bounds.push({ from: at, to: s.from })
    at = Math.min(text.length, s.to + 1)
  }
  bounds.push({ from: at, to: text.length })
  // Une diapositive vide en tete (la note commence par `---`) ne compte pas.
  const kept = bounds.filter((b, i) => i > 0 || text.slice(b.from, b.to).trim() !== '' || bounds.length === 1)
  const slides = kept.map((b, index): Slide => {
    const { markdown, notes, notesFrom } = splitNotes(text, b.from, b.to)
    const h = headingOf(markdown)
    return { index, from: b.from, to: b.to, markdown, notes, notesFrom, title: h.title, cover: startsWithH1(markdown) }
  })
  const ratio = String(prop(props, ['format', 'ratio', 'taille']) ?? '').replace(/\s/g, '') === '4:3' ? '4:3' : '16:9'
  const footer = prop(props, ['pied', 'pied de page', 'footer'])
  return {
    slides,
    theme: themeOf(prop(props, ['thème', 'theme'])),
    ratio,
    numbers: yes(prop(props, ['numéros', 'numérotation', 'pagination', 'numbers', 'paginate']), true),
    footer: typeof footer === 'string' ? footer : '',
    bodyFrom,
  }
}

/** Rang de la diapositive qui contient la position `pos` du texte. */
export function slideIndexAt(deck: SlideDeck, pos: number): number {
  let index = 0
  for (const s of deck.slides) if (pos >= s.from) index = s.index
  return index
}

/**
 * Ajoute `block` a la fin du contenu d'une diapositive (avant ses notes).
 * Rend le nouveau texte. Hors bornes : erreur.
 */
export function insertIntoSlide(text: string, slideNumber: number, block: string): string {
  const deck = slideDeck(text)
  const slide = deck.slides[slideNumber - 1]
  if (!slide) throw new Error(`Diapositive ${slideNumber} introuvable : la présentation en a ${deck.slides.length}.`)
  const end = slide.notesFrom >= 0 ? slide.notesFrom : slide.to
  const head = text.slice(0, end).replace(/\s+$/, '')
  // La suite : les notes, ou le separateur `---` de la diapositive suivante.
  const rest = text.slice(end).replace(/^\s+/, '')
  const gap = head ? '\n\n' : ''
  return rest ? `${head}${gap}${block.trim()}\n\n${rest}` : `${head}${gap}${block.trim()}\n`
}
